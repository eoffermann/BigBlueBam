import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- mocks ----------
const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
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

// Patch global fetch for slack webhook posts
const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

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

    // First select: task lookup → hit
    // Second select: state lookup → hit
    // Third select: user (assignee) lookup → hit
    let call = 0;
    mockDb.select.mockImplementation(() => {
      call++;
      if (call === 1) {
        return {
          from: () => ({
            where: () => ({
              limit: () =>
                Promise.resolve([
                  {
                    id: 'task-uuid',
                    human_id: 'MAGE-38',
                    title: 'Implement canvas zoom',
                    assignee_id: 'user-uuid',
                    phase_id: 'phase-uuid',
                    state_id: 'state-uuid',
                  },
                ]),
            }),
          }),
        };
      }
      if (call === 2) {
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
      payload: 'text=MAGE-38&command=/bbb',
    });

    const body = JSON.parse(res.body);
    expect(body.response_type).toBe('ephemeral');
    expect(body.text).toContain('MAGE-38');
    expect(body.text).toContain('Implement canvas zoom');
    expect(body.attachments[0].text).toContain('In Progress');
    expect(body.attachments[0].text).toContain('Alex Rodriguez');
    await app.close();
  });
});
