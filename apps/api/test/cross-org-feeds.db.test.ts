import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import argon2 from 'argon2';
import { randomUUID } from 'node:crypto';

/**
 * #345: the Slack slash command and the iCal "My Tasks" key feed must read ONE org in the
 * DEFAULT (advisory, BYPASSRLS) posture too. Under BBB_RLS_ENFORCE=1 the policies scoped
 * them (#338); without it the slash command looked a task up by human_id across every org
 * (tokenless requests included) and the key feed returned the key owner's assigned tasks from
 * every org instead of the key's. The queries now carry the org filter themselves.
 *
 * Runs the real routes on DATABASE_URL with enforce mode OFF (the role bypasses RLS, as the
 * default deployment does). Skips without a real database.
 */

const ADMIN_URL = process.env.DATABASE_URL;
const usable = !!ADMIN_URL && !ADMIN_URL.includes('test:test@localhost:5432/test');

vi.mock('../src/env.js', () => ({
  env: {
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://x@localhost:1/x',
    BBB_RLS_ENFORCE: false,
    NODE_ENV: 'test',
    SESSION_TTL_SECONDS: 3600,
    API_KEY_ROTATION_GRACE_MS: 7 * 24 * 3600_000,
  },
}));

(usable ? describe : describe.skip)('cross-org reads in the default RLS posture (#345)', () => {
  const admin = postgres(ADMIN_URL ?? 'postgres://x@localhost:1/x', { max: 2, onnotice: () => {} });
  const tag = Date.now().toString(36).toUpperCase();
  const orgA = randomUUID();
  const orgB = randomUUID();
  const skipper = randomUUID();
  const projA = randomUUID();
  const projB = randomUUID();
  const apiKeyA = `bbam_${tag}${randomUUID().replace(/-/g, '')}`;
  const slackToken = `slack-xorg-${tag}`;
  // Same human_id in both orgs: the shadowing case. Plus one ref that exists only in org B.
  const sharedRef = `XRG-${tag}`;
  const onlyBRef = `XRB-${tag}`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let app: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dbModule: any;

  beforeAll(async () => {
    await admin`INSERT INTO organizations (id, name, slug) VALUES
      (${orgA}, 'Gilligan Travel XORG', ${`xorg-a-${tag.toLowerCase()}`}),
      (${orgB}, 'Howell Holdings XORG', ${`xorg-b-${tag.toLowerCase()}`})`;
    await admin`INSERT INTO users (id, org_id, email, display_name, password_hash)
      VALUES (${skipper}, ${orgA}, ${`skipper-xorg-${tag}@rls.test`}, 'Skipper', '!')`;
    // The Skipper belongs to BOTH orgs; his key is pinned to org A.
    await admin`INSERT INTO organization_memberships (user_id, org_id, is_default) VALUES
      (${skipper}, ${orgA}, true), (${skipper}, ${orgB}, false)`;
    await admin`INSERT INTO projects (id, org_id, name, slug, task_id_prefix) VALUES
      (${projA}, ${orgA}, 'Rescue Signals', ${`xorg-rescue-${tag.toLowerCase()}`}, 'XRG'),
      (${projB}, ${orgB}, 'Howell Luau', ${`xorg-luau-${tag.toLowerCase()}`}, 'XRB')`;
    await admin`INSERT INTO tasks (id, project_id, org_id, human_id, title, due_date, assignee_id) VALUES
      (${randomUUID()}, ${projB}, ${orgB}, ${sharedRef}, 'Howell Luau RSVP', '2026-12-02', ${skipper}),
      (${randomUUID()}, ${projA}, ${orgA}, ${sharedRef}, 'Daily Coconut Count', '2026-12-01', ${skipper}),
      (${randomUUID()}, ${projB}, ${orgB}, ${onlyBRef}, 'Champagne Inventory', '2026-12-03', ${skipper})`;
    await admin`INSERT INTO api_keys (user_id, org_id, name, key_hash, key_prefix, scope)
      VALUES (${skipper}, ${orgA}, 'ical', ${await argon2.hash(apiKeyA, { type: argon2.argon2id })}, ${apiKeyA.slice(0, 8)}, 'read')`;
    await admin`INSERT INTO slack_integrations (project_id, webhook_url, slash_command_token)
      VALUES (${projA}, 'https://hooks.slack.invalid/x', ${slackToken})`;

    const Fastify = (await import('fastify')).default;
    const cookie = (await import('@fastify/cookie')).default;
    dbModule = await import('../src/db/index.js');
    app = Fastify({ logger: false });
    await app.register(cookie);
    await app.register((await import('../src/plugins/auth.js')).default);
    await app.register((await import('../src/plugins/rls.js')).default);
    await app.register((await import('../src/routes/ical.routes.js')).default);
    await app.register((await import('../src/routes/slack-webhook.routes.js')).default);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await admin`DELETE FROM slack_integrations WHERE project_id IN (${projA}, ${projB})`;
    await admin`DELETE FROM api_keys WHERE user_id = ${skipper}`;
    await admin`DELETE FROM tasks WHERE project_id IN (${projA}, ${projB})`;
    await admin`DELETE FROM projects WHERE id IN (${projA}, ${projB})`;
    await admin`DELETE FROM organization_memberships WHERE user_id = ${skipper}`;
    await admin`DELETE FROM users WHERE id = ${skipper}`;
    await admin`DELETE FROM organizations WHERE id IN (${orgA}, ${orgB})`;
    await admin.end();
    await dbModule?.queryClient?.end();
  });

  const slash = (payload: string) =>
    app.inject({
      method: 'POST',
      url: '/webhooks/slack/command',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload,
    });

  it('the My Tasks key feed lists only the key org tasks', async () => {
    const res = await app.inject({ method: 'GET', url: `/me/calendar.ics?token=${apiKeyA}` });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).toContain('Daily Coconut Count');
    expect(res.body).not.toContain('Howell Luau RSVP');
    expect(res.body).not.toContain('Champagne Inventory');
  });

  it('a tokenless slash command reads no org', async () => {
    const res = await slash(`text=${onlyBRef}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().text).toMatch(/not found/i);
    expect(JSON.stringify(res.json())).not.toContain('Champagne Inventory');
  });

  it("a token's slash command cannot see another org's task", async () => {
    const res = await slash(`token=${slackToken}&text=${onlyBRef}`);
    expect(res.json().text).toMatch(/not found/i);
  });

  it("finds the token org's task when another org reuses the same human_id", async () => {
    const res = await slash(`token=${slackToken}&text=${sharedRef}`);
    expect(res.json().text).toContain('Daily Coconut Count');
  });
});
