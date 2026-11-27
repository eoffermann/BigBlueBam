// slack-import: project mode create_new (#364).
//
// The worker used to INSERT INTO projects (org_id, name, key, owner_id) ... ON CONFLICT
// (org_id, key). projects has no key or owner_id column (it has slug, task_id_prefix,
// created_by; unique (org_id, slug)), so every create_new import failed. The mock DB below
// answers like the live table does: any statement that writes projects with key/owner_id raises
// Postgres' 42703. The project must now come from the api's POST /internal/projects/ensure,
// which runs the same createProject as POST /projects (membership, phases, states).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Logger } from 'pino';
import { internalEnsureProjectSchema } from '@bigbluebam/shared';

vi.mock('../src/utils/db.js', () => ({
  getDb: vi.fn(),
}));

import {
  createChannelGroup,
  importProjectBody,
  type ImportContext,
} from '../src/jobs/slack-import.job.js';
import { getDb } from '../src/utils/db.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const SKIPPER = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';

const mockLogger = {
  info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  child: vi.fn(() => mockLogger),
} as unknown as Logger;

/** A db that behaves like the live projects table for the old raw-insert shape. */
function liveShapedDb(statements: string[]) {
  return {
    execute: vi.fn(async (q: unknown) => {
      const s = JSON.stringify(q);
      statements.push(s);
      if (/INSERT INTO projects/i.test(s)) {
        // Live schema: no key / owner_id columns.
        if (/\bkey\b|owner_id/.test(s)) {
          const err = new Error('column "key" of relation "projects" does not exist') as Error & { code: string };
          err.code = '42703';
          throw err;
        }
      }
      if (s.includes('INSERT INTO banter_channel_groups')) return [{ id: 'group-1' }];
      return [];
    }),
  };
}

function ctxFor(apiFetchImpl: typeof fetch): ImportContext {
  return {
    importId: 'imp-1',
    row: {
      id: 'imp-1',
      org_id: ORG,
      project_id: null,
      channel_group_id: null,
      initiated_by: SKIPPER,
      workspace_name: 'Minnow Crew',
      source_filename: 'x.zip',
      source_size_bytes: 1,
      source_minio_key: 'k',
      mapping: {
        users: [],
        channels: [],
        project: { mode: 'create_new', name: 'Castaway Rescue', key: 'rescue' },
        options: {},
      },
      status: 'running',
      phase: null,
      totals_imported: {},
    },
    logger: mockLogger,
    redis: { publish: async () => 1 },
    storage: null,
    emailQueue: { add: async () => undefined },
    slackToken: null,
    options: {},
    dryRun: false,
    apiFetchImpl,
  } as ImportContext;
}

describe('slack-import create_new project (#364)', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.INTERNAL_SERVICE_SECRET = 'test-secret';
    process.env.BBB_API_INTERNAL_URL = 'http://api:4000/';
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('creates the project through the api, never by raw SQL with key/owner_id', async () => {
    const statements: string[] = [];
    vi.mocked(getDb).mockReturnValue(liveShapedDb(statements) as never);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const apiFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ data: { id: PROJECT, slug: 'rescue' }, created: true }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const ctx = ctxFor(apiFetch);
    const out = await createChannelGroup(ctx);

    expect(out).toEqual({ channelGroupId: 'group-1', projectId: PROJECT });
    expect(ctx.row.project_id).toBe(PROJECT);
    expect(statements.some((s) => /INSERT INTO projects/i.test(s))).toBe(false);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://api:4000/internal/projects/ensure');
    expect((calls[0]!.init.headers as Record<string, string>)['x-internal-secret']).toBe('test-secret');
    const body = JSON.parse(String(calls[0]!.init.body));
    // The body is exactly what the api route validates with (shared Zod).
    expect(internalEnsureProjectSchema.safeParse(body).success).toBe(true);
    expect(body).toEqual({
      org_id: ORG,
      created_by: SKIPPER,
      name: 'Castaway Rescue',
      slug: 'rescue',
      task_id_prefix: 'RESCUE',
    });
    expect(body).not.toHaveProperty('key');
    expect(body).not.toHaveProperty('owner_id');
  });

  it('a non-2xx from the api fails the phase instead of importing into no project', async () => {
    vi.mocked(getDb).mockReturnValue(liveShapedDb([]) as never);
    const apiFetch = vi.fn(async () => new Response('nope', { status: 422 })) as unknown as typeof fetch;
    await expect(createChannelGroup(ctxFor(apiFetch))).rejects.toThrow(/answered 422/);
  });

  it('refuses to run without INTERNAL_SERVICE_SECRET', async () => {
    delete process.env.INTERNAL_SERVICE_SECRET;
    vi.mocked(getDb).mockReturnValue(liveShapedDb([]) as never);
    const apiFetch = vi.fn() as unknown as typeof fetch;
    await expect(createChannelGroup(ctxFor(apiFetch))).rejects.toThrow(/INTERNAL_SERVICE_SECRET/);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('derives a valid slug and task_id_prefix from any key the mapping accepts', () => {
    const cases: Array<[{ name: string; key?: string | null }, { slug: string; task_id_prefix: string }]> = [
      [{ name: 'Howell Luau', key: 'HL-2026' }, { slug: 'hl-2026', task_id_prefix: 'HL' }],
      [{ name: 'Daily Coconut Count', key: '7' }, { slug: '7', task_id_prefix: 'DAILYC' }],
      [{ name: '!!!', key: '***' }, { slug: 'slack-import', task_id_prefix: 'SLK' }],
      [{ name: 'Rescue Sighting Report', key: 'a very long key that goes on and on for fifty chars' }, {
        slug: 'a-very-long-key-that-goes-on-and-on-for-fifty-chars',
        task_id_prefix: 'AVERYL',
      }],
    ];
    for (const [choice, want] of cases) {
      const body = importProjectBody(ORG, SKIPPER, choice);
      expect(body).toMatchObject(want);
      expect(internalEnsureProjectSchema.safeParse(body).success).toBe(true);
    }
  });
});
