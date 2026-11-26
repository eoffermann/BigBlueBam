import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Gate and validation tests for /internal/bastion/* (APP_DESIGN_bastion.md 8.4). The service is
// mocked; test/bastion-internal.db.test.ts drives it against a real database.

const SECRET = 'bastion-internal-test-secret-0123456789abcdef';

vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    SESSION_SECRET: 'a'.repeat(32),
    INTERNAL_SERVICE_SECRET: SECRET,
  },
}));

const { svc, publish } = vi.hoisted(() => ({
  svc: { upsertBastionTask: vi.fn(), commentOnBastionTask: vi.fn(), closeBastionProposal: vi.fn() },
  publish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/services/bastion-internal.service.js', () => {
  class BastionInternalError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  }
  return { ...svc, BastionInternalError };
});
vi.mock('../src/lib/bolt-events.js', () => ({ publishBoltEvent: publish }));

const { default: routes } = await import('../src/routes/internal-bastion.routes.js');
const { BastionInternalError } = (await import('../src/services/bastion-internal.service.js')) as unknown as {
  BastionInternalError: new (s: number, c: string, m: string) => Error;
};

const ORG = '11111111-1111-4111-8111-111111111111';
const PROJECT = '22222222-2222-4222-8222-222222222222';
const CONTROL = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const PROPOSAL = '55555555-5555-4555-8555-555555555555';

const upsertBody = {
  org_id: ORG,
  project_id: PROJECT,
  control_id: CONTROL,
  external_id: `bastion:control:${CONTROL}`,
  title: 'Fix: API keys are rotated',
  idempotency_key: 'drift:1:bam_task_upsert',
};

describe('internal-bastion routes', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    vi.clearAllMocks();
    app = Fastify({ logger: false });
    await app.register(routes, { prefix: '/internal/bastion' });
    await app.ready();
  });

  it('refuses every route without the internal secret', async () => {
    for (const url of ['/internal/bastion/tasks/upsert', '/internal/bastion/tasks/comment', `/internal/bastion/proposals/${PROPOSAL}/close`]) {
      const res = await app.inject({ method: 'POST', url, payload: {} });
      expect(res.statusCode, url).toBe(401);
      const bad = await app.inject({ method: 'POST', url, payload: {}, headers: { 'x-internal-service-secret': 'wrong' } });
      expect(bad.statusCode, url).toBe(401);
    }
    expect(svc.upsertBastionTask).not.toHaveBeenCalled();
  });

  it('upsert validates the external_id shape and answers 201 on create', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/internal/bastion/tasks/upsert',
      headers: { 'x-internal-service-secret': SECRET },
      payload: { ...upsertBody, external_id: 'helpdesk:ticket:1' },
    });
    expect(bad.statusCode).toBe(400);
    svc.upsertBastionTask.mockResolvedValueOnce({ task_id: CONTROL, human_id: 'COMP-1', outcome: 'created', comment_posted: false });
    const ok = await app.inject({ method: 'POST', url: '/internal/bastion/tasks/upsert', headers: { 'x-internal-secret': SECRET }, payload: upsertBody });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().data.outcome).toBe('created');
  });

  it('maps service errors onto the envelope', async () => {
    svc.upsertBastionTask.mockRejectedValueOnce(new BastionInternalError(404, 'PROJECT_NOT_FOUND', 'nope'));
    const res = await app.inject({ method: 'POST', url: '/internal/bastion/tasks/upsert', headers: { 'x-internal-service-secret': SECRET }, payload: upsertBody });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('PROJECT_NOT_FOUND');
  });

  it('proposal close requires a session decision and publishes proposal.decided once', async () => {
    const body = { org_id: ORG, decision: 'approved', decided_by: USER, decided_auth_method: 'api_key' };
    const bad = await app.inject({ method: 'POST', url: `/internal/bastion/proposals/${PROPOSAL}/close`, headers: { 'x-internal-service-secret': SECRET }, payload: body });
    expect(bad.statusCode).toBe(400);
    svc.closeBastionProposal.mockResolvedValueOnce({ result: { proposal_id: PROPOSAL, status: 'approved', already_closed: false }, event: { proposal: { id: PROPOSAL } } });
    const ok = await app.inject({
      method: 'POST',
      url: `/internal/bastion/proposals/${PROPOSAL}/close`,
      headers: { 'x-internal-service-secret': SECRET },
      payload: { ...body, decided_auth_method: 'session' },
    });
    expect(ok.statusCode).toBe(200);
    expect(publish).toHaveBeenCalledWith('proposal.decided', 'platform', { proposal: { id: PROPOSAL } }, ORG, USER, 'user');
    svc.closeBastionProposal.mockResolvedValueOnce({ result: { proposal_id: PROPOSAL, status: 'approved', already_closed: true }, event: null });
    await app.inject({
      method: 'POST',
      url: `/internal/bastion/proposals/${PROPOSAL}/close`,
      headers: { 'x-internal-service-secret': SECRET },
      payload: { ...body, decided_auth_method: 'session' },
    });
    expect(publish).toHaveBeenCalledTimes(1);
  });
});
