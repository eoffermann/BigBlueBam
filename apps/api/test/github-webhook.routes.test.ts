import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { createHmac } from 'node:crypto';

// Migration 0273 / Bastion spec 3.1 and 8.4: the GitHub webhook stores hook.events from `ping`
// in github_integrations.subscribed_events, and appends EVERY pull_request and
// pull_request_review delivery to github_pr_events, whether or not it mentions a Bam task.

const { mockDb, state } = vi.hoisted(() => {
  const state = {
    rowsByTable: new Map<unknown, unknown[]>(),
    updates: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
    inserts: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  };
  function chain(table?: unknown) {
    const c: Record<string, unknown> = {};
    let t = table;
    c.from = (tbl: unknown) => {
      t = tbl;
      return c;
    };
    c.where = () => c;
    c.limit = () => c;
    c.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(state.rowsByTable.get(t) ?? []).then(resolve, reject);
    return c;
  }
  const mockDb = {
    select: vi.fn(() => chain()),
    update: vi.fn((table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          state.updates.push({ table, values });
        },
      }),
    })),
    insert: vi.fn((table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        state.inserts.push({ table, values });
        const done = Promise.resolve([]);
        return {
          onConflictDoNothing: () => Object.assign(done, { returning: async () => [] }),
          returning: async () => [],
        };
      },
    })),
  };
  return { mockDb, state };
});

vi.mock('../src/db/index.js', () => ({ db: mockDb, connection: { end: vi.fn() } }));
vi.mock('../src/services/activity.service.js', () => ({ logActivity: vi.fn(async () => {}) }));

import githubWebhookRoutes from '../src/routes/github-webhook.routes.js';
import { githubIntegrations, githubPrEvents } from '../src/db/schema/github-integrations.js';
import { projects } from '../src/db/schema/projects.js';
import { tasks } from '../src/db/schema/tasks.js';

const SECRET = 'e'.repeat(64);
const ORG = '11111111-1111-1111-1111-111111111111';
const PROJECT = '22222222-2222-2222-2222-222222222222';
const INTEGRATION = '33333333-3333-3333-3333-333333333333';

const integrationRow = {
  id: INTEGRATION,
  project_id: PROJECT,
  repo_owner: 'skipper',
  repo_name: 'rescue-radio-firmware',
  webhook_secret: SECRET,
  transition_on_pr_open_phase_id: null,
  transition_on_pr_merged_phase_id: null,
  enabled: true,
  created_by: null,
};

const repository = {
  name: 'rescue-radio-firmware',
  owner: { login: 'skipper' },
  default_branch: 'main',
};

async function deliver(app: FastifyInstance, event: string, payload: unknown, delivery = 'd-1') {
  const body = JSON.stringify(payload);
  return app.inject({
    method: 'POST',
    url: '/webhooks/github',
    headers: {
      'content-type': 'application/json',
      'x-github-event': event,
      'x-github-delivery': delivery,
      'x-hub-signature-256': `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`,
    },
    payload: body,
  });
}

describe('POST /webhooks/github (Bastion change evidence)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    state.rowsByTable = new Map<unknown, unknown[]>([
      [githubIntegrations, [integrationRow]],
      [projects, [{ org_id: ORG }]],
      [tasks, []],
    ]);
    state.updates = [];
    state.inserts = [];
    app = Fastify();
    await app.register(githubWebhookRoutes);
    await app.ready();
  });

  it('ping stores hook.events as subscribed_events', async () => {
    const res = await deliver(app, 'ping', {
      zen: 'Keep it logically awesome.',
      hook: { events: ['pull_request', 'push', 'pull_request_review', 'push'] },
      repository,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.subscribed_events).toEqual(['pull_request', 'pull_request_review', 'push']);
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.table).toBe(githubIntegrations);
    expect(state.updates[0]!.values.subscribed_events).toEqual([
      'pull_request',
      'pull_request_review',
      'push',
    ]);
    expect(state.inserts).toHaveLength(0);
  });

  it('ping without a usable hook.events leaves subscribed_events untouched (NULL = unknown)', async () => {
    const res = await deliver(app, 'ping', { zen: 'z', repository });
    expect(res.statusCode).toBe(200);
    expect(state.updates).toHaveLength(0);
  });

  it('a bad signature stores nothing', async () => {
    const body = JSON.stringify({ hook: { events: ['push'] }, repository });
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/github',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'ping',
        'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
      },
      payload: body,
    });
    expect(res.statusCode).toBe(401);
    expect(state.updates).toHaveLength(0);
    expect(state.inserts).toHaveLength(0);
  });

  it('records a merged pull_request that mentions no task', async () => {
    const res = await deliver(
      app,
      'pull_request',
      {
        action: 'closed',
        repository,
        pull_request: {
          number: 42,
          title: 'Retune the coconut radio',
          body: 'No ticket, just a quick fix',
          html_url: 'https://github.com/skipper/rescue-radio-firmware/pull/42',
          merged: true,
          merged_at: '2026-11-20T10:00:00Z',
          merged_by: { login: 'gilligan' },
          merge_commit_sha: 'f'.repeat(40),
          user: { login: 'gilligan' },
          head: { sha: 'a'.repeat(40) },
          base: { ref: 'main' },
        },
      },
      'delivery-42',
    );
    expect(res.statusCode).toBe(200);
    const recorded = state.inserts.filter((i) => i.table === githubPrEvents);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.values).toMatchObject({
      org_id: ORG,
      integration_id: INTEGRATION,
      project_id: PROJECT,
      repo_owner: 'skipper',
      repo_name: 'rescue-radio-firmware',
      delivery_id: 'delivery-42',
      event_type: 'pull_request',
      action: 'closed',
      pr_number: 42,
      pr_author_login: 'gilligan',
      merged: true,
      merged_by_login: 'gilligan',
      base_ref: 'main',
      default_branch: 'main',
      task_refs: [],
    });
    expect((recorded[0]!.values.merged_at as Date).toISOString()).toBe('2026-11-20T10:00:00.000Z');
  });

  it('records a pull_request_review delivery', async () => {
    const res = await deliver(app, 'pull_request_review', {
      action: 'submitted',
      repository,
      review: {
        id: 9000000001,
        state: 'APPROVED',
        submitted_at: '2026-11-20T09:00:00Z',
        commit_id: 'a'.repeat(40),
        user: { login: 'professor' },
      },
      pull_request: { number: 42, title: 'Retune the coconut radio', user: { login: 'gilligan' }, base: { ref: 'main' } },
    });
    expect(res.statusCode).toBe(200);
    const recorded = state.inserts.filter((i) => i.table === githubPrEvents);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.values).toMatchObject({
      event_type: 'pull_request_review',
      action: 'submitted',
      pr_number: 42,
      review_id: 9000000001,
      review_state: 'approved',
      reviewer_login: 'professor',
      merged: false,
    });
  });

  it('a disabled integration records nothing', async () => {
    state.rowsByTable.set(githubIntegrations, [{ ...integrationRow, enabled: false }]);
    const res = await deliver(app, 'pull_request', {
      action: 'opened',
      repository,
      pull_request: { number: 7, title: 'x', user: { login: 'ginger' } },
    });
    expect(res.statusCode).toBe(200);
    expect(state.inserts).toHaveLength(0);
  });
});
