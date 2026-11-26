import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// ---------- hoisted mocks ----------
const { mockDb } = vi.hoisted(() => {
  return {
    mockDb: {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
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
    SESSION_SECRET: 'a'.repeat(32),
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

// Stub auth helpers so tests can toggle identity via a header.
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
  requireScope: () => async (request: any, reply: any) => {
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

// Stub publishBoltEvent so tests can verify it's called with bare event names
// and source 'platform'. The real impl is fire-and-forget so these call sites
// never affect observable test state except through the spy.
const publishBoltEventSpy = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../src/lib/bolt-events.js', () => ({
  publishBoltEvent: publishBoltEventSpy,
}));

import proposalRoutes from '../src/routes/proposals.routes.js';

// ---------- test user helpers ----------
interface TestUser {
  id: string;
  active_org_id: string;
  kind: 'human' | 'agent' | 'service';
  role: string;
  is_superuser: boolean;
  org_id: string;
}

const ORG_A = '11111111-1111-1111-1111-111111111111';
const ORG_B = '22222222-2222-2222-2222-222222222222';

const HUMAN_USER: TestUser = {
  id: '88888888-8888-8888-8888-888888888888',
  active_org_id: ORG_A,
  kind: 'human',
  role: 'member',
  is_superuser: false,
  org_id: ORG_A,
};
const ADMIN_USER: TestUser = {
  id: '99999999-9999-9999-9999-999999999999',
  active_org_id: ORG_A,
  kind: 'human',
  role: 'admin',
  is_superuser: false,
  org_id: ORG_A,
};
const AGENT_USER: TestUser = {
  id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  active_org_id: ORG_A,
  kind: 'service',
  role: 'member',
  is_superuser: false,
  org_id: ORG_A,
};
const OTHER_HUMAN: TestUser = {
  id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
  active_org_id: ORG_A,
  kind: 'human',
  role: 'member',
  is_superuser: false,
  org_id: ORG_A,
};

const SUPERUSER: TestUser = {
  id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  active_org_id: ORG_A,
  kind: 'human',
  role: 'owner',
  is_superuser: true,
  org_id: ORG_A,
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.decorateRequest('user', null);
  app.decorateRequest('impersonator', null);
  app.decorateRequest('isImpersonating', false);
  app.addHook('preHandler', async (request) => {
    if (request.headers['x-test-impersonated'] === '1') {
      (request as any).isImpersonating = true;
      (request as any).impersonator = SUPERUSER;
    }
    const header = request.headers['x-test-user'];
    if (header === 'human') (request as any).user = HUMAN_USER;
    else if (header === 'admin') (request as any).user = ADMIN_USER;
    else if (header === 'agent') (request as any).user = AGENT_USER;
    else if (header === 'other') (request as any).user = OTHER_HUMAN;
  });
  await app.register(proposalRoutes);
  return app;
}

// ---------- drizzle chain mock helpers ----------

function mockInsertReturning(rows: any[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const values = vi.fn().mockReturnValue({ returning });
  mockDb.insert.mockReturnValueOnce({ values });
}

function mockSelectFromWhereLimit(rows: any[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  mockDb.select.mockReturnValueOnce({ from });
}

function mockSelectListFlow(rows: any[]) {
  // select().from().where().orderBy().limit()
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  mockDb.select.mockReturnValueOnce({ from });
}

function mockUpdateReturning(rows: any[]) {
  const returning = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ returning });
  const set = vi.fn().mockReturnValue({ where });
  mockDb.update.mockReturnValueOnce({ set });
  return set;
}

// ---------- tests ----------

describe('proposals routes', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    app = await buildApp();
  });

  describe('POST /v1/proposals', () => {
    it('returns 401 without auth', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/proposals',
        payload: { proposed_action: 'x', approver_id: OTHER_HUMAN.id },
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 400 on missing approver_id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/proposals',
        headers: { 'x-test-user': 'human' },
        payload: { proposed_action: 'x' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when ttl_seconds exceeds the 30-day maximum', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/proposals',
        headers: { 'x-test-user': 'human' },
        payload: {
          proposed_action: 'x',
          approver_id: OTHER_HUMAN.id,
          ttl_seconds: 60 * 60 * 24 * 31, // 31 days
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    });

    it('creates a proposal and fires proposal.created with source platform', async () => {
      const now = new Date();
      const future = new Date(now.getTime() + 7 * 86400_000);
      mockInsertReturning([
        {
          id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
          org_id: ORG_A,
          actor_id: HUMAN_USER.id,
          proposer_kind: 'human',
          proposed_action: 'blast.campaign.send',
          proposed_payload: {},
          subject_type: 'blast.campaign',
          subject_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
          approver_id: OTHER_HUMAN.id,
          status: 'pending',
          decided_at: null,
          decision_reason: null,
          expires_at: future,
          created_at: now,
          updated_at: now,
        },
      ]);

      const res = await app.inject({
        method: 'POST',
        url: '/v1/proposals',
        headers: { 'x-test-user': 'human' },
        payload: {
          proposed_action: 'blast.campaign.send',
          approver_id: OTHER_HUMAN.id,
          subject_type: 'blast.campaign',
          subject_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
        },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().data.status).toBe('pending');
      expect(res.json().data.approver_id).toBe(OTHER_HUMAN.id);

      // Bolt event was fired with bare event name and source 'platform'.
      expect(publishBoltEventSpy).toHaveBeenCalledTimes(1);
      const args = publishBoltEventSpy.mock.calls[0]!;
      expect(args[0]).toBe('proposal.created');
      expect(args[1]).toBe('platform');
      const payload = args[2] as any;
      expect(payload.proposal.proposed_action).toBe('blast.campaign.send');
      expect(payload.proposal.url).toContain('/b3/approvals/');
    });
  });

  describe('GET /v1/proposals', () => {
    it('returns 401 without auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/v1/proposals' });
      expect(res.statusCode).toBe(401);
    });

    it('returns the list scoped to the caller by default (status=pending)', async () => {
      const now = new Date();
      mockSelectListFlow([
        {
          id: 'row-1',
          org_id: ORG_A,
          actor_id: OTHER_HUMAN.id,
          approver_id: HUMAN_USER.id,
          status: 'pending',
          proposed_action: 'x',
          created_at: now,
          expires_at: new Date(now.getTime() + 86400_000),
        },
      ]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/proposals',
        headers: { 'x-test-user': 'human' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toHaveLength(1);
      expect(body.meta.has_more).toBe(false);
    });

    it('honors an explicit status filter', async () => {
      mockSelectListFlow([]);
      const res = await app.inject({
        method: 'GET',
        url: '/v1/proposals?filter[status]=approved',
        headers: { 'x-test-user': 'human' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data).toEqual([]);
    });
  });

  describe('POST /v1/proposals/:id/decide', () => {
    const PROPOSAL_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const existingPending = () => ({
      id: PROPOSAL_ID,
      org_id: ORG_A,
      actor_id: OTHER_HUMAN.id,
      proposer_kind: 'human',
      proposed_action: 'blast.campaign.send',
      approver_id: HUMAN_USER.id,
      status: 'pending',
      decided_at: null,
      decision_reason: null,
      expires_at: new Date(Date.now() + 86400_000),
      created_at: new Date(),
      updated_at: new Date(),
      proposed_payload: {},
      subject_type: null,
      subject_id: null,
    });

    it('returns 404 when the proposal is in another org', async () => {
      mockSelectFromWhereLimit([]); // RLS-style scope means not found
      const res = await app.inject({
        method: 'POST',
        url: `/v1/proposals/${PROPOSAL_ID}/decide`,
        headers: { 'x-test-user': 'human' },
        payload: { decision: 'approve' },
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 403 when caller is not approver and not an org admin', async () => {
      mockSelectFromWhereLimit([existingPending()]);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/proposals/${PROPOSAL_ID}/decide`,
        headers: { 'x-test-user': 'other' },
        payload: { decision: 'approve' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    });

    it('returns 409 if the proposal is already decided', async () => {
      mockSelectFromWhereLimit([{ ...existingPending(), status: 'approved' }]);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/proposals/${PROPOSAL_ID}/decide`,
        headers: { 'x-test-user': 'human' },
        payload: { decision: 'approve' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PROPOSAL_ALREADY_DECIDED');
    });

    it('returns 410 when the proposal has expired (and flips to expired)', async () => {
      const expired = { ...existingPending(), expires_at: new Date(Date.now() - 1000) };
      mockSelectFromWhereLimit([expired]);
      const set = mockUpdateReturning([{ id: PROPOSAL_ID }]); // lazy transition to 'expired'
      const res = await app.inject({
        method: 'POST',
        url: `/v1/proposals/${PROPOSAL_ID}/decide`,
        headers: { 'x-test-user': 'human' },
        payload: { decision: 'approve' },
      });
      expect(res.statusCode).toBe(410);
      expect(res.json().error.code).toBe('PROPOSAL_EXPIRED');
      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(set).toHaveBeenCalledWith(expect.objectContaining({ status: 'expired' }));
    });

    it('guards the lazy-expiry write on pending/revising status (issue #141)', async () => {
      const expired = { ...existingPending(), expires_at: new Date(Date.now() - 1000) };
      mockSelectFromWhereLimit([expired]);
      const set = mockUpdateReturning([{ id: PROPOSAL_ID }]);
      await app.inject({
        method: 'POST',
        url: `/v1/proposals/${PROPOSAL_ID}/decide`,
        headers: { 'x-test-user': 'human' },
        payload: { decision: 'approve' },
      });
      const where = set.mock.results[0]!.value.where as ReturnType<typeof vi.fn>;
      const predicate = where.mock.calls[0]![0];
      // The predicate must reference the status column, not just the id.
      const seen = new WeakSet<object>();
      const columnNames: string[] = [];
      const walk = (node: unknown): void => {
        if (!node || typeof node !== 'object' || seen.has(node as object)) return;
        seen.add(node as object);
        const n = node as Record<string, unknown>;
        if (typeof n.name === 'string' && 'columnType' in n) columnNames.push(n.name);
        for (const v of Object.values(n)) {
          if (Array.isArray(v)) v.forEach(walk);
          else if (v && typeof v === 'object' && !('table' in (v as object) && 'columnType' in n)) walk(v);
        }
      };
      walk(predicate);
      expect(columnNames).toContain('status');
      expect(columnNames).toContain('id');
    });

    it('does not overwrite a concurrent approval with expired (issue #141)', async () => {
      // Both callers read 'pending'; the approver committed first, so the guarded
      // expiry write matches no row. The late caller must see 409, not 410.
      const expired = { ...existingPending(), expires_at: new Date(Date.now() - 1000) };
      mockSelectFromWhereLimit([expired]);
      mockUpdateReturning([]);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/proposals/${PROPOSAL_ID}/decide`,
        headers: { 'x-test-user': 'human' },
        payload: { decision: 'approve' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PROPOSAL_ALREADY_DECIDED');
      expect(publishBoltEventSpy).not.toHaveBeenCalled();
    });

    it('approves a pending proposal and fires proposal.decided', async () => {
      mockSelectFromWhereLimit([existingPending()]);
      const updated = { ...existingPending(), status: 'approved', decided_at: new Date() };
      mockUpdateReturning([updated]);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/proposals/${PROPOSAL_ID}/decide`,
        headers: { 'x-test-user': 'human' },
        payload: { decision: 'approve', reason: 'looks good' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe('approved');

      const calls = publishBoltEventSpy.mock.calls;
      expect(calls.length).toBeGreaterThanOrEqual(1);
      const last = calls[calls.length - 1]!;
      expect(last[0]).toBe('proposal.decided');
      expect(last[1]).toBe('platform');
      expect((last[2] as any).proposal.decision).toBe('approve');
    });

    it('request_revision transitions a pending proposal to revising', async () => {
      mockSelectFromWhereLimit([existingPending()]);
      const updated = { ...existingPending(), status: 'revising', decided_at: new Date() };
      mockUpdateReturning([updated]);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/proposals/${PROPOSAL_ID}/decide`,
        headers: { 'x-test-user': 'human' },
        payload: { decision: 'request_revision', reason: 'clarify the payload' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe('revising');
    });

    it('rejects a pending proposal', async () => {
      mockSelectFromWhereLimit([existingPending()]);
      const updated = { ...existingPending(), status: 'rejected', decided_at: new Date() };
      mockUpdateReturning([updated]);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/proposals/${PROPOSAL_ID}/decide`,
        headers: { 'x-test-user': 'human' },
        payload: { decision: 'reject' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().data.status).toBe('rejected');
    });

    it('allows org admins to decide even when they are not the approver', async () => {
      mockSelectFromWhereLimit([existingPending()]);
      const updated = { ...existingPending(), status: 'approved', decided_at: new Date() };
      mockUpdateReturning([updated]);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/proposals/${PROPOSAL_ID}/decide`,
        headers: { 'x-test-user': 'admin' },
        payload: { decision: 'approve' },
      });
      expect(res.statusCode).toBe(200);
    });

    // ---- issue #128: decider record, require_human_decider, owning_app ----

    it('records decided_by, decided_by_kind and no impersonator on a normal decide', async () => {
      mockSelectFromWhereLimit([existingPending()]);
      const set = mockUpdateReturning([
        {
          ...existingPending(),
          status: 'approved',
          decided_at: new Date(),
          decided_by: HUMAN_USER.id,
          decided_by_kind: 'human',
          decided_impersonator_id: null,
        },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/proposals/${PROPOSAL_ID}/decide`,
        headers: { 'x-test-user': 'human' },
        payload: { decision: 'approve' },
      });
      expect(res.statusCode).toBe(200);
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({
          decided_by: HUMAN_USER.id,
          decided_by_kind: 'human',
          decided_impersonator_id: null,
        }),
      );
      expect(res.json().data.decided_by_kind).toBe('human');
      const last = publishBoltEventSpy.mock.calls.at(-1)!;
      expect((last[2] as any).proposal.decided_by_kind).toBe('human');
    });

    it('records the impersonating SuperUser when deciding under impersonation', async () => {
      mockSelectFromWhereLimit([existingPending()]);
      const set = mockUpdateReturning([{ ...existingPending(), status: 'approved' }]);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/proposals/${PROPOSAL_ID}/decide`,
        headers: { 'x-test-user': 'human', 'x-test-impersonated': '1' },
        payload: { decision: 'approve' },
      });
      expect(res.statusCode).toBe(200);
      expect(set).toHaveBeenCalledWith(
        expect.objectContaining({ decided_by: HUMAN_USER.id, decided_impersonator_id: SUPERUSER.id }),
      );
    });

    it('records a service-account decider kind', async () => {
      mockSelectFromWhereLimit([{ ...existingPending(), approver_id: AGENT_USER.id }]);
      const set = mockUpdateReturning([{ ...existingPending(), status: 'rejected' }]);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/proposals/${PROPOSAL_ID}/decide`,
        headers: { 'x-test-user': 'agent' },
        payload: { decision: 'reject' },
      });
      expect(res.statusCode).toBe(200);
      expect(set).toHaveBeenCalledWith(expect.objectContaining({ decided_by_kind: 'service' }));
    });

    it('returns 409 DECIDE_IN_APP for an app-owned proposal and does not update it', async () => {
      mockSelectFromWhereLimit([{ ...existingPending(), owning_app: 'bastion' }]);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/proposals/${PROPOSAL_ID}/decide`,
        headers: { 'x-test-user': 'admin' },
        payload: { decision: 'approve' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('DECIDE_IN_APP');
      expect(mockDb.update).not.toHaveBeenCalled();
      expect(publishBoltEventSpy).not.toHaveBeenCalled();
    });

    it('rejects a service-account decider when require_human_decider is set', async () => {
      mockSelectFromWhereLimit([
        { ...existingPending(), approver_id: AGENT_USER.id, require_human_decider: true },
      ]);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/proposals/${PROPOSAL_ID}/decide`,
        headers: { 'x-test-user': 'agent' },
        payload: { decision: 'approve' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('HUMAN_DECIDER_REQUIRED');
      expect(mockDb.update).not.toHaveBeenCalled();
    });

    it('rejects an impersonated decider when require_human_decider is set', async () => {
      mockSelectFromWhereLimit([{ ...existingPending(), require_human_decider: true }]);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/proposals/${PROPOSAL_ID}/decide`,
        headers: { 'x-test-user': 'human', 'x-test-impersonated': '1' },
        payload: { decision: 'approve' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('HUMAN_DECIDER_REQUIRED');
    });

    it('allows a human decider when require_human_decider is set', async () => {
      mockSelectFromWhereLimit([{ ...existingPending(), require_human_decider: true }]);
      mockUpdateReturning([{ ...existingPending(), status: 'approved' }]);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/proposals/${PROPOSAL_ID}/decide`,
        headers: { 'x-test-user': 'human' },
        payload: { decision: 'approve' },
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns 409 when a concurrent decider won the guarded update', async () => {
      mockSelectFromWhereLimit([existingPending()]);
      mockUpdateReturning([]);
      const res = await app.inject({
        method: 'POST',
        url: `/v1/proposals/${PROPOSAL_ID}/decide`,
        headers: { 'x-test-user': 'human' },
        payload: { decision: 'approve' },
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PROPOSAL_ALREADY_DECIDED');
      expect(publishBoltEventSpy).not.toHaveBeenCalled();
    });
  });

  describe('POST /v1/proposals owning_app (issue #128)', () => {
    it('refuses owning_app from a non-service caller', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/proposals',
        headers: { 'x-test-user': 'human' },
        payload: { proposed_action: 'x', approver_id: OTHER_HUMAN.id, owning_app: 'bastion' },
      });
      expect(res.statusCode).toBe(403);
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('stores owning_app and require_human_decider from a service account', async () => {
      const now = new Date();
      const returning = vi.fn().mockResolvedValue([
        {
          id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
          org_id: ORG_A,
          actor_id: AGENT_USER.id,
          proposer_kind: 'service',
          proposed_action: 'bastion.exception.accept',
          approver_id: HUMAN_USER.id,
          status: 'pending',
          owning_app: 'bastion',
          require_human_decider: true,
          expires_at: new Date(now.getTime() + 86400_000),
          created_at: now,
          subject_type: null,
          subject_id: null,
        },
      ]);
      const values = vi.fn().mockReturnValue({ returning });
      mockDb.insert.mockReturnValueOnce({ values });
      const res = await app.inject({
        method: 'POST',
        url: '/v1/proposals',
        headers: { 'x-test-user': 'agent' },
        payload: {
          proposed_action: 'bastion.exception.accept',
          approver_id: HUMAN_USER.id,
          owning_app: 'bastion',
          require_human_decider: true,
        },
      });
      expect(res.statusCode).toBe(201);
      expect(values).toHaveBeenCalledWith(
        expect.objectContaining({ owning_app: 'bastion', require_human_decider: true }),
      );
    });
  });
});
