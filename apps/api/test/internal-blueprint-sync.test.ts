import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// POST /internal/sync-from-blueprint writes a Blueprint node's label and
// description into the Bam task the node references. The node's
// ref_entity_id is caller-controlled, so the write must be confined to the
// diagram's org or a Blueprint user can rewrite any org's task by UUID.

const { conditions, state } = vi.hoisted(() => ({
  conditions: [] as unknown[],
  state: { current: { title: 'old', description: null as string | null } as unknown },
}));

vi.mock('../src/env.js', () => ({ env: { NODE_ENV: 'test', LOG_LEVEL: 'silent' } }));
vi.mock('../src/lib/internal-secret.js', () => ({ requireInternalSecretOrToken: async () => {} }));
vi.mock('../src/services/realtime.service.js', () => ({ broadcastToProject: vi.fn() }));
vi.mock('../src/db/index.js', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (cond: unknown) => {
          conditions.push(cond);
          return { limit: async () => (state.current ? [state.current] : []) };
        },
      }),
    }),
    update: () => ({
      set: () => ({
        where: (cond: unknown) => {
          conditions.push(cond);
          return { returning: async () => [{ id: 't1', project_id: 'p1' }] };
        },
      }),
    }),
  },
}));

import internalBlueprintSyncRoutes from '../src/routes/internal-blueprint-sync.routes.js';

const TASK = '11111111-1111-4111-8111-111111111111';
const ORG = '22222222-2222-4222-8222-222222222222';
const dialect = new PgDialect();
const render = (cond: unknown) => dialect.sqlToQuery(cond as SQL);

describe('POST /internal/sync-from-blueprint', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify({ logger: false });
    await app.register(internalBlueprintSyncRoutes);
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    conditions.length = 0;
    state.current = { title: 'old', description: null };
  });

  it('rejects a sync that does not say which org the diagram belongs to', async () => {
    const res = await app.inject({ method: 'POST', url: '/internal/sync-from-blueprint', payload: { task_id: TASK, title: 'pwned' } });
    expect(res.statusCode).toBe(400);
    expect(conditions).toEqual([]);
  });

  it('scopes both the read and the UPDATE to the diagram org', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/internal/sync-from-blueprint',
      payload: { task_id: TASK, org_id: ORG, title: 'new' },
    });
    expect(res.statusCode).toBe(200);
    expect(conditions).toHaveLength(2);
    for (const cond of conditions) {
      const q = render(cond);
      expect(q.sql).toContain('"org_id"');
      expect(q.params).toContain(ORG);
      expect(q.params).toContain(TASK);
    }
  });

  it('answers 404 when the task is not in that org', async () => {
    state.current = undefined;
    const res = await app.inject({
      method: 'POST',
      url: '/internal/sync-from-blueprint',
      payload: { task_id: TASK, org_id: ORG, title: 'new' },
    });
    expect(res.statusCode).toBe(404);
  });
});
