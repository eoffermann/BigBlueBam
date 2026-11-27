import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- mocks ----------
const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    // orgOfProject (lib/rls-org-scope.ts): the slash-command token's integration org.
    execute: vi.fn(async () => [{ org_id: 'org-gilligan' }]),
  };
  return { mockDb };
});

vi.mock('../src/db/index.js', () => ({
  db: mockDb,
  connection: { end: vi.fn() },
}));

vi.mock('../src/env.js', () => ({
  env: {
    PUBLIC_URL: 'http://localhost/b3',
    DATABASE_URL: 'postgres://test',
    NODE_ENV: 'test',
    PORT: 4000,
    HOST: '0.0.0.0',
    SESSION_SECRET: 'a'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'info',
  },
}));

// Slack posts go through egress-guard's safeFetch (#328); the mock records the
// calls so a regression back to a bare fetch() fails these tests.
const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('@bigbluebam/egress-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@bigbluebam/egress-guard')>()),
  safeFetch: fetchMock,
}));
vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('bare fetch() used instead of safeFetch'); }));

import { postToSlack } from '../src/services/slack-notify.service.js';

// ---------- helpers ----------
function chainSelect(rows: unknown[]) {
  const limitFn = vi.fn().mockResolvedValue(rows);
  const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn });
  mockDb.select.mockReturnValue({ from: fromFn });
  return { fromFn, whereFn, limitFn };
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockReset();
  fetchMock.mockResolvedValue({ ok: true, status: 200 });
});

describe('postToSlack', () => {
  it('is a no-op when no integration row exists', async () => {
    chainSelect([]);
    await postToSlack('project-1', { event_type: 'task.created', text: 'hello' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is a no-op when integration.enabled is false', async () => {
    chainSelect([
      {
        webhook_url: 'https://example.com/hook',
        enabled: false,
        notify_on_task_created: true,
        notify_on_task_completed: true,
        notify_on_sprint_started: true,
        notify_on_sprint_completed: true,
      },
    ]);
    await postToSlack('project-1', { event_type: 'task.created', text: 'hello' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('respects the notify_on_task_created flag', async () => {
    chainSelect([
      {
        webhook_url: 'https://example.com/hook',
        enabled: true,
        notify_on_task_created: false,
        notify_on_task_completed: true,
        notify_on_sprint_started: true,
        notify_on_sprint_completed: true,
      },
    ]);
    await postToSlack('project-1', { event_type: 'task.created', text: 'hello' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('posts to the webhook when enabled and event flag is on', async () => {
    chainSelect([
      {
        webhook_url: 'https://example.com/hook',
        enabled: true,
        notify_on_task_created: true,
        notify_on_task_completed: true,
        notify_on_sprint_started: true,
        notify_on_sprint_completed: true,
      },
    ]);
    await postToSlack('project-1', { event_type: 'task.created', text: 'hello' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://example.com/hook');
    expect((opts as { method: string }).method).toBe('POST');
    const body = JSON.parse((opts as { body: string }).body);
    expect(body.text).toBe('hello');
  });

  it('never throws when fetch rejects (fire-and-forget)', async () => {
    chainSelect([
      {
        webhook_url: 'https://example.com/hook',
        enabled: true,
        notify_on_task_created: true,
        notify_on_task_completed: true,
        notify_on_sprint_started: true,
        notify_on_sprint_completed: true,
      },
    ]);
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    await expect(
      postToSlack('project-1', { event_type: 'task.created', text: 'hello' }),
    ).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Slash command route tests
// ─────────────────────────────────────────────────────────────────────────
//
// We spin up a minimal Fastify instance with just the slack webhook route
// so we can smoke-test the three paths: empty text (usage), bad ref
// (not found), and valid ref (task blocks).
describe('slack slash command', () => {
  it('returns usage when text is empty', async () => {
    const Fastify = (await import('fastify')).default;
    const { default: slackWebhookRoutes } = await import('../src/routes/slack-webhook.routes.js');
    const app = Fastify();
    await app.register(slackWebhookRoutes);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/slack/command',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'text=&command=/bbb',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.response_type).toBe('ephemeral');
    expect(body.text).toMatch(/TASK-REF/);
    await app.close();
  });

  it('returns not-found for an unmatched ref', async () => {
    const Fastify = (await import('fastify')).default;
    const { default: slackWebhookRoutes } = await import('../src/routes/slack-webhook.routes.js');
    const app = Fastify();
    await app.register(slackWebhookRoutes);

    // task lookup returns empty
    chainSelect([]);

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/slack/command',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'text=NOPE-99&command=/bbb',
    });

    const body = JSON.parse(res.body);
    expect(body.response_type).toBe('ephemeral');
    expect(body.text).toMatch(/not found/i);
    await app.close();
  });

  it('returns task summary when ref matches', async () => {
    const Fastify = (await import('fastify')).default;
    const { default: slackWebhookRoutes } = await import('../src/routes/slack-webhook.routes.js');
    const app = Fastify();
    await app.register(slackWebhookRoutes);

    // 1: integration by token, 2: task lookup, 3: integration-for-project check,
    // 4: state lookup, 5: user (assignee) lookup.
    let call = 0;
    let taskWhere: unknown = null;
    mockDb.select.mockImplementation(() => {
      call++;
      if (call === 1 || call === 3) {
        return {
          from: () => ({
            where: () => ({ limit: () => Promise.resolve([{ id: 'int-uuid', project_id: 'proj-uuid' }]) }),
          }),
        };
      }
      if (call === 2) {
        return {
          from: () => ({
            where: (cond: unknown) => {
              taskWhere = cond;
              return {
                limit: () =>
                  Promise.resolve([
                    {
                      id: 'task-uuid',
                      human_id: 'MAGE-38',
                      title: 'Implement canvas zoom',
                      assignee_id: 'user-uuid',
                      phase_id: 'phase-uuid',
                      state_id: 'state-uuid',
                      project_id: 'proj-uuid',
                    },
                  ]),
              };
            },
          }),
        };
      }
      if (call === 4) {
        return {
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve([{ name: 'In Progress' }]),
            }),
          }),
        };
      }
      // user lookup
      return {
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([{ display_name: 'Alex Rodriguez' }]),
          }),
        }),
      };
    });

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/slack/command',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'token=slack-tok&text=MAGE-38&command=/bbb',
    });

    const body = JSON.parse(res.body);
    expect(body.response_type).toBe('ephemeral');
    expect(body.text).toContain('MAGE-38');
    expect(body.text).toContain('Implement canvas zoom');
    expect(body.attachments[0].text).toContain('In Progress');
    expect(body.attachments[0].text).toContain('Alex Rodriguez');
    // #345: the human_id lookup is confined to the token's integration org.
    const { PgDialect } = await import('drizzle-orm/pg-core');
    const q = new PgDialect().sqlToQuery(taskWhere as never);
    expect(q.sql).toContain('"org_id" = $');
    expect(q.params).toContain('org-gilligan');
    await app.close();
  });

  // #345: without a token there is no org, so nothing is read (the advisory posture used to
  // search every org's tasks by human_id).
  it('finds nothing without a slash-command token, and reads no task', async () => {
    const Fastify = (await import('fastify')).default;
    const { default: slackWebhookRoutes } = await import('../src/routes/slack-webhook.routes.js');
    const app = Fastify();
    await app.register(slackWebhookRoutes);
    mockDb.select.mockImplementation(() => {
      throw new Error('no query expected');
    });

    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/slack/command',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'text=MAGE-38&command=/bbb',
    });

    expect(JSON.parse(res.body).text).toMatch(/not found/i);
    expect(mockDb.select).not.toHaveBeenCalled();
    await app.close();
  });
});
