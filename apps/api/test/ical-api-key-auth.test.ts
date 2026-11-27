import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

/**
 * The iCal "My Tasks" feed authenticates by a bbam_ API key in ?token=. It used
 * to carry its own copy of the key check, which refused an expired key even
 * inside its rotation grace window (the auth plugin accepted it), skipped the
 * owner-active check, and had no DoS cap. Both paths now call
 * verifyApiKeyToken; these tests pin the iCal side to that one rule.
 */

const { mockDb, mockArgon2 } = vi.hoisted(() => ({
  mockDb: {
    execute: vi.fn(),
    select: vi.fn(),
    transaction: vi.fn(),
  },
  mockArgon2: { verify: vi.fn(), hash: vi.fn() },
}));

vi.mock('../src/db/index.js', () => ({
  db: mockDb,
  // The feed's task read runs in the key's org scope (#338); here it just runs.
  runInOrgScope: async (_orgId: string, fn: () => Promise<unknown>) => fn(),
  connection: { end: vi.fn() },
}));
vi.mock('argon2', () => ({ default: mockArgon2 }));
vi.mock('../src/env.js', () => ({ env: { NODE_ENV: 'test', BBB_RLS_ENFORCE: false } }));
vi.mock('../src/plugins/auth.js', () => ({
  requireAuth: vi.fn(async () => {}),
  requireScope: () => vi.fn(async () => {}),
}));
vi.mock('../src/middleware/authorize.js', () => ({ requireProjectAccess: () => vi.fn(async () => {}) }));

const USER = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const KEY = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'bbam_abcdefghijklmnopqrstuvwxyz';

const hour = 3600_000;
function keyRow(over: Record<string, unknown>) {
  return {
    id: KEY,
    user_id: USER,
    org_id: ORG,
    name: 'feed',
    key_hash: '$argon2id$stored',
    key_prefix: TOKEN.slice(0, 8),
    scope: 'read',
    project_ids: null,
    expires_at: null,
    created_at: new Date().toISOString(),
    last_used_at: null,
    rotated_at: null,
    rotation_grace_expires_at: null,
    predecessor_id: null,
    ...over,
  };
}

const owner = {
  id: USER,
  org_id: ORG,
  email: 'skipper@gilligantravel.example',
  display_name: 'Skipper',
  avatar_url: null,
  timezone: 'UTC',
  is_active: true,
  is_superuser: false,
  kind: 'human',
};

/** db.select() chain: .from().where() resolves for the owner lookup and the task read. */
function selectReturning(rows: unknown[]) {
  const chain: Record<string, unknown> = {};
  chain.from = vi.fn(() => chain);
  chain.innerJoin = vi.fn(() => chain);
  chain.where = vi.fn(() => Promise.resolve(rows));
  return chain;
}

/** One row of the shared candidate query: the key joined to its owner (owner_* columns). */
function candidateRow(key: Record<string, unknown>, ownerOver: Record<string, unknown>) {
  const o = { ...owner, ...ownerOver };
  return {
    ...keyRow(key),
    owner_org_id: o.org_id,
    owner_email: o.email,
    owner_display_name: o.display_name,
    owner_avatar_url: o.avatar_url,
    owner_timezone: o.timezone,
    owner_is_active: o.is_active,
    owner_is_superuser: o.is_superuser,
    owner_kind: o.kind,
  };
}

async function feed(key: Record<string, unknown>, ownerOver: Record<string, unknown> = {}) {
  // First execute: the @bigbluebam/auth-core candidate query (auth_api_key_candidates joined to
  // users). Later ones (auth_touch_api_key) return nothing.
  mockDb.execute.mockResolvedValue([]);
  mockDb.execute.mockResolvedValueOnce([candidateRow(key, ownerOver)]);
  mockDb.select
    .mockReturnValueOnce(
      selectReturning([
        { id: 't1', human_id: 'RSA-1', title: 'Count coconuts', description: null, due_date: '2026-12-01', priority: 'high' },
      ]),
    );
  const icalRoutes = (await import('../src/routes/ical.routes.js')).default;
  const app = Fastify({ logger: false });
  await app.register(icalRoutes);
  await app.ready();
  const res = await app.inject({ method: 'GET', url: `/me/calendar.ics?token=${TOKEN}` });
  await app.close();
  return res;
}

describe('iCal ?token= uses the shared API-key verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockArgon2.verify.mockResolvedValue(true);
  });

  it('serves the feed for a live key', async () => {
    const res = await feed({});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain('Count coconuts');
  });

  it('accepts an expired key inside its rotation grace window (as the Bearer path does)', async () => {
    const res = await feed({
      expires_at: new Date(Date.now() - hour).toISOString(),
      rotated_at: new Date(Date.now() - 2 * hour).toISOString(),
      rotation_grace_expires_at: new Date(Date.now() + hour).toISOString(),
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('refuses an expired key whose grace window has closed', async () => {
    const res = await feed({
      expires_at: new Date(Date.now() - 2 * hour).toISOString(),
      rotated_at: new Date(Date.now() - 3 * hour).toISOString(),
      rotation_grace_expires_at: new Date(Date.now() - hour).toISOString(),
    });
    expect(res.statusCode).toBe(401);
  });

  // #343: a superseded key with no expires_at authenticated forever after rotation.
  it('refuses a rotated key with no expires_at once its grace window has closed', async () => {
    const res = await feed({
      expires_at: null,
      rotated_at: new Date(Date.now() - 8 * 24 * hour).toISOString(),
      rotation_grace_expires_at: new Date(Date.now() - hour).toISOString(),
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a rotated key with no expires_at inside its grace window', async () => {
    const res = await feed({
      expires_at: null,
      rotated_at: new Date(Date.now() - hour).toISOString(),
      rotation_grace_expires_at: new Date(Date.now() + hour).toISOString(),
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it("refuses a key whose owner is deactivated", async () => {
    const res = await feed({}, { is_active: false });
    expect(res.statusCode).toBe(401);
  });

  it('refuses a wrong secret', async () => {
    mockArgon2.verify.mockResolvedValue(false);
    const res = await feed({});
    expect(res.statusCode).toBe(401);
  });
});
