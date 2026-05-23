// Deploy settings route + service tests.
//
// Exercises the three /superuser/deploy/* endpoints plus the encrypt/decrypt
// helpers in deploy-settings.service.ts. The service layer talks to a mocked
// db.* (insert / select / delete) so we can verify token encryption masking,
// the omit/null/string token convention, and round-trip semantics without
// standing up a real postgres. GitHub fetches are mocked via vi.stubGlobal.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ─── Hoisted mocks ────────────────────────────────────────────────
// In-memory key→value store keyed by the system_settings key. Reads and
// writes flow through this map so the service's "round-trip after PUT"
// semantics are observable in tests.
const { mockDb, mockStore } = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return {
    mockStore: store,
    mockDb: {
      select: vi.fn(),
      insert: vi.fn(),
      delete: vi.fn(),
    },
  };
});

vi.mock('../src/env.js', () => ({
  env: {
    SESSION_TTL_SECONDS: 604800,
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    NODE_ENV: 'test',
    PORT: 4000,
    HOST: '0.0.0.0',
    SESSION_SECRET: 'deploy-test-secret-padded-to-32!!',
    REDIS_URL: 'redis://localhost:6379',
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    UPLOAD_MAX_FILE_SIZE: 10485760,
    UPLOAD_ALLOWED_TYPES: 'image/*',
    COOKIE_SECURE: false,
  },
}));

vi.mock('../src/db/index.js', () => ({
  db: mockDb,
  connection: { end: vi.fn() },
}));

vi.mock('../src/plugins/auth.js', () => ({
  requireAuth: async (request: any, reply: any) => {
    if (!request.user) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          details: [],
          request_id: request.id,
        },
      });
    }
  },
}));

vi.mock('../src/services/superuser-audit.service.js', () => ({
  logSuperuserAction: vi.fn().mockResolvedValue(undefined),
}));

// ─── Imports (after mocks) ────────────────────────────────────────
import deploySettingsRoutes, {
  parseGitHubRepoUrl,
} from '../src/routes/deploy-settings.routes.js';
import {
  encryptToken,
  decryptToken,
} from '../src/services/deploy-settings.service.js';

// ─── Test scaffolding ─────────────────────────────────────────────
const SUPERUSER = { id: 'su-1', is_superuser: true };
const AVERY = { id: 'avery-1', is_superuser: false };

// Wire up the mocked drizzle chains. The service does:
//   1. select({key, value}).from(systemSettings).where(inArray(...)) — returns rows
//   2. insert(systemSettings).values(...).onConflictDoUpdate({set: ...}) — upsert
//   3. delete(systemSettings).where(eq(key, X)) — clear key
//
// We stub each chain so the in-memory mockStore is consulted/mutated and
// the same fixture works for every test.
function wireDbToStore(): void {
  mockDb.select.mockImplementation(() => {
    const where = vi.fn(async () => {
      const rows: { key: string; value: unknown }[] = [];
      for (const [key, value] of mockStore.entries()) {
        rows.push({ key, value });
      }
      return rows;
    });
    const from = vi.fn().mockReturnValue({ where });
    return { from };
  });

  mockDb.insert.mockImplementation(() => {
    const onConflictDoUpdate = vi.fn(async (_opts: any) => {
      // Capture handled via .values() below.
    });
    let pendingKey: string | undefined;
    let pendingValue: unknown;
    const values = vi.fn((rec: any) => {
      pendingKey = rec.key;
      // The service stores JSON.stringify(value) — we have to JSON.parse
      // here so the in-memory store mirrors what postgres' jsonb column
      // would return on the next select (i.e. the decoded JS value).
      pendingValue =
        typeof rec.value === 'string' ? JSON.parse(rec.value) : rec.value;
      return {
        onConflictDoUpdate: async () => {
          if (pendingKey) mockStore.set(pendingKey, pendingValue);
        },
      };
    });
    return { values };
  });

  mockDb.delete.mockImplementation(() => {
    const where = vi.fn(async () => {
      // delete returns a promise of an unknown; we can't see the eq()
      // argument from drizzle's outside surface. Instead the test
      // helper that calls delete also resets the store key directly
      // when needed; the service uses delete only for the token and
      // repo_url keys explicitly, so we just need to be able to await
      // the call. Tracking is via mock.calls length.
      return [];
    });
    return { where };
  });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // requireCan stand-in. Gate on is_superuser exactly like the production
  // resolver does for requires_superuser=true catalog entries.
  (app as any).decorate(
    'requireCan',
    () => async (request: any, reply: any) => {
      if (!request.user) {
        return reply.status(401).send({
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }
      if (!request.user.is_superuser) {
        return reply.status(403).send({
          error: { code: 'PERMISSION_DENIED', message: 'SuperUser required' },
        });
      }
    },
  );

  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    const header = request.headers['x-test-user'];
    if (header === 'superuser') (request as any).user = SUPERUSER;
    else if (header === 'avery') (request as any).user = AVERY;
  });

  await app.register(deploySettingsRoutes);
  return app;
}

// ─── Encryption round-trip ────────────────────────────────────────
describe('deploy-settings token encryption', () => {
  it('round-trips a plaintext token through enc:<...> form', () => {
    const plain = 'ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789';
    const enc = encryptToken(plain);
    expect(enc.startsWith('enc:')).toBe(true);
    // Format: enc:<iv-b64>:<ct-b64>:<tag-b64> — four colon-segments.
    expect(enc.split(':')).toHaveLength(4);
    expect(decryptToken(enc)).toBe(plain);
  });

  it('returns null for malformed input', () => {
    expect(decryptToken('not-encrypted')).toBeNull();
    expect(decryptToken('enc:only:two')).toBeNull();
  });
});

// ─── URL parser ───────────────────────────────────────────────────
describe('parseGitHubRepoUrl', () => {
  it('accepts https://github.com/owner/repo.git', () => {
    const r = parseGitHubRepoUrl('https://github.com/eoffermann/BigBlueBam.git');
    expect(r).toEqual({ owner: 'eoffermann', repo: 'BigBlueBam' });
  });

  it('accepts the bare form without .git', () => {
    const r = parseGitHubRepoUrl('https://github.com/eoffermann/BigBlueBam');
    expect(r).toEqual({ owner: 'eoffermann', repo: 'BigBlueBam' });
  });

  it('rejects gitlab.com with INVALID_URL', () => {
    const r = parseGitHubRepoUrl('https://gitlab.com/owner/repo.git');
    expect(r).toHaveProperty('error', 'INVALID_URL');
  });

  it('rejects ssh-form URLs', () => {
    const r = parseGitHubRepoUrl('git@github.com:owner/repo.git');
    expect(r).toHaveProperty('error', 'INVALID_URL');
  });

  it('rejects a URL with no owner/repo segments', () => {
    const r = parseGitHubRepoUrl('https://github.com/');
    expect(r).toHaveProperty('error', 'INVALID_URL');
  });
});

// ─── Route tests ──────────────────────────────────────────────────
describe('Deploy settings routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockStore.clear();
    wireDbToStore();
    app = await buildApp();
  });

  // ── Auth gating ─────────────────────────────────────────────────
  describe('auth gating (avery — non-SU)', () => {
    it('returns 403 on GET /superuser/deploy/settings', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/superuser/deploy/settings',
        headers: { 'x-test-user': 'avery' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 403 on PUT /superuser/deploy/settings', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/superuser/deploy/settings',
        headers: { 'x-test-user': 'avery' },
        payload: { deploy_branch: 'main' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 403 on POST /superuser/deploy/verify-repo', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/superuser/deploy/verify-repo',
        headers: { 'x-test-user': 'avery' },
        payload: { deploy_repo_url: 'https://github.com/owner/repo' },
      });
      expect(res.statusCode).toBe(403);
    });

    it('returns 401 with no auth header', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/superuser/deploy/settings',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── GET (defaults) ──────────────────────────────────────────────
  describe('GET /superuser/deploy/settings', () => {
    it('returns defaults when no rows exist', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/superuser/deploy/settings',
        headers: { 'x-test-user': 'superuser' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.deploy_branch).toBe('stable');
      expect(body.data.deploy_github_token_set).toBe(false);
      expect(body.data.deploy_auto_update_enabled).toBe(true);
      expect(body.data.defaults.deploy_branch).toBe('stable');
      // deploy_repo_url should be the git origin or null; the test
      // environment may or may not have a git remote configured.
      expect(typeof body.data.deploy_repo_url).toBe('string');
    });
  });

  // ── PUT round-trip ──────────────────────────────────────────────
  describe('PUT round-trip', () => {
    it('saves then GET reflects the new values', async () => {
      const putRes = await app.inject({
        method: 'PUT',
        url: '/superuser/deploy/settings',
        headers: { 'x-test-user': 'superuser' },
        payload: {
          deploy_branch: 'main',
          deploy_auto_update_enabled: false,
        },
      });
      expect(putRes.statusCode).toBe(200);
      const putBody = putRes.json();
      expect(putBody.data.deploy_branch).toBe('main');
      expect(putBody.data.deploy_auto_update_enabled).toBe(false);

      const getRes = await app.inject({
        method: 'GET',
        url: '/superuser/deploy/settings',
        headers: { 'x-test-user': 'superuser' },
      });
      expect(getRes.statusCode).toBe(200);
      const getBody = getRes.json();
      expect(getBody.data.deploy_branch).toBe('main');
      expect(getBody.data.deploy_auto_update_enabled).toBe(false);
    });

    it('PUT with a token: GET shows deploy_github_token_set=true and stored value starts with enc:', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/superuser/deploy/settings',
        headers: { 'x-test-user': 'superuser' },
        payload: {
          deploy_github_token: 'ghp_testtokenABCDEFG',
        },
      });
      expect(res.statusCode).toBe(200);

      // The store should now have the encrypted value, not the
      // plaintext.
      const stored = mockStore.get('deploy_github_token');
      expect(typeof stored).toBe('string');
      expect((stored as string).startsWith('enc:')).toBe(true);

      const getRes = await app.inject({
        method: 'GET',
        url: '/superuser/deploy/settings',
        headers: { 'x-test-user': 'superuser' },
      });
      expect(getRes.json().data.deploy_github_token_set).toBe(true);
    });

    it('PUT with deploy_github_token=null clears the row', async () => {
      // Seed the store with an encrypted token.
      mockStore.set('deploy_github_token', encryptToken('ghp_existing'));

      // Verify the seed appears via GET.
      const before = await app.inject({
        method: 'GET',
        url: '/superuser/deploy/settings',
        headers: { 'x-test-user': 'superuser' },
      });
      expect(before.json().data.deploy_github_token_set).toBe(true);

      // Clear via null. Note: the test's mocked db.delete() doesn't
      // observe the actual eq() filter, so we mirror the clear into
      // mockStore manually to make the next GET match what postgres'
      // DELETE would have done. The service still calls db.delete()
      // with the right key (verifiable below).
      const res = await app.inject({
        method: 'PUT',
        url: '/superuser/deploy/settings',
        headers: { 'x-test-user': 'superuser' },
        payload: { deploy_github_token: null },
      });
      expect(res.statusCode).toBe(200);
      // Service called db.delete().where(...) for the token key.
      expect(mockDb.delete).toHaveBeenCalled();

      // Manual mirror: emulate the DELETE so the next GET sees the
      // cleared state.
      mockStore.delete('deploy_github_token');

      const after = await app.inject({
        method: 'GET',
        url: '/superuser/deploy/settings',
        headers: { 'x-test-user': 'superuser' },
      });
      expect(after.json().data.deploy_github_token_set).toBe(false);
    });

    it('PUT with omitted token: keeps existing', async () => {
      // Seed with an encrypted token.
      const seeded = encryptToken('ghp_keepme');
      mockStore.set('deploy_github_token', seeded);

      // Update only the branch — should NOT touch the token row.
      const res = await app.inject({
        method: 'PUT',
        url: '/superuser/deploy/settings',
        headers: { 'x-test-user': 'superuser' },
        payload: { deploy_branch: 'main' },
      });
      expect(res.statusCode).toBe(200);
      expect(mockDb.delete).not.toHaveBeenCalled();

      // Token is still set after the GET.
      const after = await app.inject({
        method: 'GET',
        url: '/superuser/deploy/settings',
        headers: { 'x-test-user': 'superuser' },
      });
      expect(after.json().data.deploy_github_token_set).toBe(true);
      // And the stored value didn't change.
      expect(mockStore.get('deploy_github_token')).toBe(seeded);
    });
  });

  // ── verify-repo ─────────────────────────────────────────────────
  describe('POST /superuser/deploy/verify-repo', () => {
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
    });

    it('returns ok on a 200 from GitHub', async () => {
      fetchMock.mockResolvedValueOnce({
        status: 200,
        json: async () => ({
          default_branch: 'main',
          private: false,
        }),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/superuser/deploy/verify-repo',
        headers: { 'x-test-user': 'superuser' },
        payload: {
          deploy_repo_url: 'https://github.com/eoffermann/BigBlueBam.git',
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data.ok).toBe(true);
      expect(body.data.owner).toBe('eoffermann');
      expect(body.data.repo).toBe('BigBlueBam');
      expect(body.data.default_branch).toBe('main');
      expect(body.data.private).toBe(false);
    });

    it('returns VERIFY_FAILED + REPO_NOT_FOUND hint when token provided and GitHub 404s', async () => {
      fetchMock.mockResolvedValueOnce({
        status: 404,
        json: async () => ({ message: 'Not Found' }),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/superuser/deploy/verify-repo',
        headers: { 'x-test-user': 'superuser' },
        payload: {
          deploy_repo_url: 'https://github.com/owner/notexist',
          deploy_github_token: 'ghp_present',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe('VERIFY_FAILED');
      expect(body.error.details[0].github_status).toBe(404);
      expect(body.error.details[0].hint).toBe('REPO_NOT_FOUND');
    });

    it('returns AUTH_REQUIRED hint when GitHub 404s with no token (private repo case)', async () => {
      fetchMock.mockResolvedValueOnce({
        status: 404,
        json: async () => ({ message: 'Not Found' }),
      });

      const res = await app.inject({
        method: 'POST',
        url: '/superuser/deploy/verify-repo',
        headers: { 'x-test-user': 'superuser' },
        payload: {
          deploy_repo_url: 'https://github.com/owner/private-repo',
        },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error.code).toBe('VERIFY_FAILED');
      expect(body.error.details[0].hint).toBe('AUTH_REQUIRED');
    });

    it('returns INVALID_URL for gitlab.com', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/superuser/deploy/verify-repo',
        headers: { 'x-test-user': 'superuser' },
        payload: {
          deploy_repo_url: 'https://gitlab.com/owner/repo.git',
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('INVALID_URL');
      // GitHub fetch should not have been attempted.
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
