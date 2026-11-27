import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { test, expect } from '../../../fixtures/base.fixture';
import { DirectApiClient } from '../../../api/api-client';
import { loginViaUI, readCsrfTokenFromCookies } from '../../../auth/auth.helper';
import type { APIRequestContext, Browser, BrowserContext, TestInfo } from '@playwright/test';

// Bastion M10 user stories 12-15 (spec 11.4), against the GILLIGAN seed:
//   12. Gilligan attests; coverage rises ("0 of 1" becomes "1 of 1" on Skipper's Policies page).
//   13. Gilligan (a member) sees no Sharing actions, and POST /auditor-rooms is 403.
//   14. Skipper impersonating Gilligan cannot attest or decide (403 IMPERSONATION_NOT_ALLOWED,
//       and the buttons are disabled with the "viewing as another person" note).
//   15. Help opens the Bastion guide.
//
// Auth: the default context is Skipper (cookie session); Gilligan signs in through the UI in his
// own context with the cast password (E2E_GILLIGAN_PASSWORD, default the GILLIGAN seed password).
//
// Self-cleaning. Attestations are immutable ledger entries, so these stories never touch the
// seeded "Island Information Security Policy" (its "5 of 7" is a seed expectation). Instead they
// create two throwaway Beacon articles, link each as a policy whose audience is Gilligan alone,
// and in afterAll retire both policies and retire both articles. The attestation story 12 records
// stays in the ledger against a retired policy, which is what the ledger is for. Story 14 needs
// Skipper to be a SuperUser (the seed does not make him one): if he is not, the suite grants it
// with the api CLI and revokes it in afterAll, and every impersonation session it starts is
// stopped.
//
// Backend read-back: the API as the same user, and psql through `docker compose exec postgres`
// (the same route global-setup uses for the CLI), always filtered by organization_id.

const REPO_ROOT = path.join(__dirname, '..', '..', '..', '..', '..', '..');
const ORG_SLUG = 'gilligan-travel-ltd';
const SKIPPER = process.env.E2E_ADMIN_EMAIL || 'skipper@gilligantravel.example';
const GILLIGAN = 'gilligan@gilligantravel.example';
const GILLIGAN_PASSWORD = process.env.E2E_GILLIGAN_PASSWORD || 'Castaway2026!';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IMPERSONATING_ATTEST = 'You are viewing Bastion as another person. Only that person can acknowledge this.';
const BASTION = '/bastion/api/v1';
const BEACON = '/beacon/api/v1';

/** One psql query through the compose postgres container; returns the unaligned, tuples-only text. */
function psql(sql: string): string {
  return execFileSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      process.env.E2E_PG_USER || 'bigbluebam',
      '-d',
      process.env.E2E_PG_DB || 'bigbluebam',
      '-tA',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      sql,
    ],
    { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

/** Only ids that look like ids are ever put into SQL. */
function id(v: string | null | undefined): string {
  if (!v || !UUID_RE.test(v)) throw new Error(`not an id: ${String(v)}`);
  return v;
}

function apiCli(...args: string[]): string {
  return execFileSync('docker', ['compose', 'exec', '-T', 'api', 'node', 'dist/cli.js', ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

async function apiFor(request: APIRequestContext, context: BrowserContext, base: string): Promise<DirectApiClient> {
  const csrf = readCsrfTokenFromCookies(await context.cookies()) || undefined;
  return new DirectApiClient(request, base, csrf);
}

async function skipperContext(browser: Browser, testInfo: TestInfo): Promise<BrowserContext> {
  return browser.newContext({ baseURL: testInfo.project.use.baseURL, storageState: testInfo.project.use.storageState as string });
}

/** A fresh context signed in as Gilligan through the login page. */
async function gilliganContext(browser: Browser, testInfo: TestInfo): Promise<BrowserContext> {
  const ctx = await browser.newContext({ baseURL: testInfo.project.use.baseURL, storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await loginViaUI(page, { email: GILLIGAN, password: GILLIGAN_PASSWORD });
  await page.close();
  return ctx;
}

const stamp = Date.now();
const titleA = `Coconut Radio Etiquette, story 12 ${stamp}`;
const titleB = `Lagoon Swimming Rules, story 14 ${stamp}`;

let orgId = '';
let gilliganId = '';
const articles: string[] = [];
const policies: Record<'a' | 'b', string | null> = { a: null, b: null };
let grantedSuperuser = false;
let startedAt = '';

/** Create a published, org-visible Beacon article and link it as a policy for Gilligan alone. */
async function linkPolicyFor(api: DirectApiClient, beacon: DirectApiClient, title: string): Promise<string> {
  const created = await beacon.postRaw('/beacons', {
    title,
    summary: 'A short island rule for the castaways to read and acknowledge.',
    body_markdown: `# ${title}\n\nUse the coconut radio for rescue traffic only. Keep calls short and sign off with your name.`,
    visibility: 'Organization',
  });
  expect(created.status, JSON.stringify(created.body)).toBeLessThan(300);
  const entryId = id((created.body as { data: { id: string } }).data.id);
  articles.push(entryId);
  const published = await beacon.postRaw(`/beacons/${entryId}/publish`, {});
  expect(published.status, JSON.stringify(published.body)).toBeLessThan(300);

  const linked = await api.postRaw('/policies', {
    beacon_entry_id: entryId,
    audience: { kind: 'users', user_ids: [gilliganId] },
    cadence_days: 365,
  });
  expect(linked.status, JSON.stringify(linked.body)).toBe(201);
  return id((linked.body as { data: { id: string } }).data.id);
}

async function policyLabel(api: DirectApiClient, policyId: string): Promise<string | null> {
  const list = (await api.getRaw('/policies')).body as { data: Array<{ id: string; attestation_label: string | null }> };
  return list.data.find((p) => p.id === policyId)?.attestation_label ?? null;
}

test.describe.serial('Bastion - people, permissions and help (M10)', () => {
  test.beforeAll(async ({ browser }, testInfo) => {
    orgId = id(psql(`SELECT id FROM organizations WHERE slug = '${ORG_SLUG}'`));
    gilliganId = id(psql(`SELECT id FROM users WHERE lower(email) = '${GILLIGAN}'`));
    startedAt = psql('SELECT now()');
    const ctx = await skipperContext(browser, testInfo);
    try {
      const api = await apiFor(ctx.request, ctx, BASTION);
      const beacon = await apiFor(ctx.request, ctx, BEACON);
      policies.a = await linkPolicyFor(api, beacon, titleA);
      policies.b = await linkPolicyFor(api, beacon, titleB);
    } finally {
      await ctx.close();
    }
  });

  test.afterAll(async ({ browser }, testInfo) => {
    const ctx = await skipperContext(browser, testInfo);
    try {
      const api = await apiFor(ctx.request, ctx, BASTION);
      for (const p of [policies.a, policies.b]) if (p) await api.patch(`/policies/${p}`, { status: 'retired' }).catch(() => undefined);
      const beacon = await apiFor(ctx.request, ctx, BEACON);
      for (const a of articles) await beacon.delete(`/beacons/${a}`).catch(() => undefined);
    } finally {
      await ctx.close();
      if (grantedSuperuser) apiCli('revoke-superuser', '--email', SKIPPER);
    }
    // The throwaway policies are retired, scoped to the GILLIGAN org.
    for (const p of [policies.a, policies.b]) {
      if (p) expect(psql(`SELECT status FROM bastion_policies WHERE organization_id = '${orgId}' AND id = '${id(p)}'`)).toBe('retired');
    }
  });

  test('12. Gilligan attests; coverage rises', async ({ page, browser, request, context }, testInfo) => {
    const api = await apiFor(request, context, BASTION);
    expect(await policyLabel(api, policies.a!)).toBe('0 of 1 have read the current version');

    const gctx = await gilliganContext(browser, testInfo);
    try {
      const gpage = await gctx.newPage();
      await gpage.goto('/bastion/attest');
      await expect(gpage.getByRole('heading', { name: 'Policies to read' })).toBeVisible();
      const row = gpage.getByTestId('to-read-row').filter({ hasText: titleA });
      await row.getByRole('button', { name: 'Read it' }).click();
      const reader = gpage.getByTestId('policy-reader');
      await expect(reader.getByTestId('policy-body')).toContainText('coconut radio for rescue traffic only');
      await reader.getByRole('button', { name: 'I have read and understood this' }).click();
      await expect(reader).toContainText('You acknowledged this version on');

      // Gilligan's own list now says it is done.
      const mine = (await (await apiFor(gctx.request, gctx, BASTION)).getRaw('/me/attestations')).body as { data: Array<{ policy_id: string; due: boolean }> };
      expect(mine.data.find((r) => r.policy_id === policies.a)?.due).toBe(false);
    } finally {
      await gctx.close();
    }

    // Coverage rises for the policy owner, in the API and on the Policies page.
    expect(await policyLabel(api, policies.a!)).toBe('1 of 1 have read the current version');
    const who = (await api.getRaw(`/policies/${policies.a}/attestations`)).body as { data: Record<string, unknown> };
    expect(JSON.stringify(who.data)).toContain(gilliganId);
    await page.goto('/bastion/policies');
    await expect(page.getByTestId('policy-row').filter({ hasText: titleA })).toContainText('1 of 1 have read the current version');

    // psql: exactly one attestation by Gilligan for the served version, and its ledger entry.
    const pa = id(policies.a);
    const attestationId = id(
      psql(`SELECT id FROM bastion_policy_attestations WHERE organization_id = '${orgId}' AND policy_id = '${pa}' AND user_id = '${gilliganId}'`),
    );
    expect(psql(`SELECT count(*) FROM bastion_ledger_entries WHERE organization_id = '${orgId}' AND entry_kind = 'attestation' AND entry_id = '${attestationId}'`)).toBe('1');
  });

  test('13. Gilligan sees no Sharing actions; POST /auditor-rooms is 403', async ({ browser }, testInfo) => {
    const roomsBefore = psql(`SELECT count(*) FROM bastion_auditor_rooms WHERE organization_id = '${orgId}'`);
    const gctx = await gilliganContext(browser, testInfo);
    try {
      const gpage = await gctx.newPage();
      await gpage.goto('/bastion/sharing');
      await expect(gpage.getByRole('heading', { name: 'Sharing', exact: true })).toBeVisible();
      await gpage.waitForLoadState('networkidle');
      for (const name of ['Create auditor room', 'Build a packet', 'Revoke', 'Unlock', 'Answer']) {
        await expect(gpage.getByRole('button', { name }), name).toHaveCount(0);
      }
      await expect(gpage.getByRole('heading', { name: 'Auditor rooms' })).toHaveCount(0);

      const gapi = await apiFor(gctx.request, gctx, BASTION);
      const setup = (await gapi.getRaw('/setup')).body as { data: { frameworks: Array<{ id: string; status: string }> } };
      const fw = setup.data.frameworks.find((f) => f.status !== 'archived');
      expect(fw, 'the GILLIGAN org has a framework adopted').toBeDefined();
      const today = new Date().toISOString().slice(0, 10);
      const create = await gapi.postRaw('/auditor-rooms', { label: `Gilligan's room ${stamp}`, framework_id: fw!.id, period_start: today, period_end: today, confirm: true });
      expect(create.status).toBe(403);
      expect((create.body as { error: { code: string } }).error.code).toBe('PERMISSION_DENIED');
      expect((await gapi.getRaw('/auditor-rooms')).status).toBe(403);
    } finally {
      await gctx.close();
    }

    // Nothing was created and no auditor_room.created event was queued.
    expect(psql(`SELECT count(*) FROM bastion_auditor_rooms WHERE organization_id = '${orgId}'`)).toBe(roomsBefore);
    expect(
      psql(
        `SELECT count(*) FROM bastion_outbox WHERE organization_id = '${orgId}' AND kind = 'bolt_event' AND payload->>'event_type' = 'auditor_room.created' AND created_at >= '${startedAt}'::timestamptz`,
      ),
    ).toBe('0');
  });

  test('14. Skipper impersonating Gilligan cannot attest or decide', async ({ browser }, testInfo) => {
    if (psql(`SELECT is_superuser FROM users WHERE lower(email) = '${SKIPPER.toLowerCase()}'`) !== 't') {
      apiCli('grant-superuser', '--email', SKIPPER);
      grantedSuperuser = true;
    }
    const pb = id(policies.b);
    const ctx = await skipperContext(browser, testInfo);
    let impersonating = false;
    try {
      const csrf = readCsrfTokenFromCookies(await ctx.cookies()) || '';
      const mutate = { 'X-CSRF-Token': csrf };
      // The permission cache may take a moment to see the new SuperUser.
      await expect
        .poll(async () => (await ctx.request.post('/b3/api/v1/platform/impersonate', { data: { user_id: gilliganId }, headers: mutate })).status(), {
          timeout: 30_000,
        })
        .toBe(200);
      impersonating = true;
      const as = { ...mutate, 'X-Impersonate-User': gilliganId };

      // The UI: Gilligan's policy, read as Gilligan, with the button disabled and the note shown.
      await ctx.addInitScript((uid) => {
        window.localStorage.setItem('bbb-impersonation', JSON.stringify({ user_id: uid, display_name: 'Gilligan' }));
      }, gilliganId);
      const page = await ctx.newPage();
      await page.goto('/bastion/attest');
      const row = page.getByTestId('to-read-row').filter({ hasText: titleB });
      await row.getByRole('button', { name: 'Read it' }).click();
      const reader = page.getByTestId('policy-reader');
      await expect(reader.getByRole('button', { name: 'I have read and understood this' })).toBeDisabled();
      await expect(reader).toContainText(IMPERSONATING_ATTEST);

      // The API: attest and both decide routes refuse the impersonated session.
      const body = (await (await ctx.request.get(`${BASTION}/policies/${pb}/body`, { headers: as })).json()) as {
        data: { beacon_version: number; body_sha256: string };
      };
      const attest = await ctx.request.post(`${BASTION}/policies/${pb}/attest`, {
        headers: as,
        data: { beacon_version: body.data.beacon_version, body_sha256: body.data.body_sha256 },
      });
      expect(attest.status()).toBe(403);
      expect(((await attest.json()) as { error: { code: string } }).error.code).toBe('IMPERSONATION_NOT_ALLOWED');

      const drafts = (await (await ctx.request.get(`${BASTION}/fix-drafts`, { headers: as, params: { status: 'proposed' } })).json()) as {
        data: Array<{ id: string }>;
      };
      const draftId = drafts.data[0]?.id ?? '00000000-0000-4000-8000-000000000000';
      const decideFix = await ctx.request.post(`${BASTION}/fix-drafts/${draftId}/decide`, { headers: as, data: { decision: 'approve' } });
      expect(decideFix.status()).toBe(403);
      expect(((await decideFix.json()) as { error: { code: string } }).error.code).toBe('IMPERSONATION_NOT_ALLOWED');

      const exceptions = (await (await ctx.request.get(`${BASTION}/exceptions`, { headers: as, params: { status: 'proposed' } })).json()) as {
        data: Array<{ id: string }>;
      };
      const exceptionId = exceptions.data[0]?.id ?? '00000000-0000-4000-8000-000000000001';
      const decideException = await ctx.request.post(`${BASTION}/exceptions/${exceptionId}/decide`, { headers: as, data: { decision: 'approve', confirm: true } });
      expect(decideException.status()).toBe(403);
      expect(((await decideException.json()) as { error: { code: string } }).error.code).toBe('IMPERSONATION_NOT_ALLOWED');

      // Nothing changed: no attestation by Gilligan on policy B, the draft is still proposed.
      expect(psql(`SELECT count(*) FROM bastion_policy_attestations WHERE organization_id = '${orgId}' AND policy_id = '${pb}' AND user_id = '${gilliganId}'`)).toBe('0');
      if (drafts.data[0]) {
        expect(psql(`SELECT status FROM bastion_fix_drafts WHERE organization_id = '${orgId}' AND id = '${id(draftId)}'`)).toBe('proposed');
      }
    } finally {
      if (impersonating) {
        await ctx.request.post('/b3/api/v1/platform/stop-impersonation', {
          headers: { 'X-CSRF-Token': readCsrfTokenFromCookies(await ctx.cookies()) || '', 'X-Impersonate-User': gilliganId },
        });
      }
      await ctx.close();
    }
    expect(
      psql(`SELECT count(*) FROM impersonation_sessions WHERE target_user_id = '${gilliganId}' AND ended_at IS NULL AND started_at >= '${startedAt}'::timestamptz`),
    ).toBe('0');
  });

  test('15. Help opens the Bastion guide', async ({ page }) => {
    await page.goto('/bastion/');
    const index = page.waitForResponse((r) => r.url().includes('/docs/apps/bastion/help-index.json'));
    await page.getByRole('button', { name: 'Help', exact: true }).click();
    const res = await index;
    expect(res.status()).toBe(200);
    expect(((await res.json()) as { app: string }).app).toBe('bastion');

    const dialog = page.getByRole('dialog', { name: 'Bastion help' });
    await expect(dialog).toBeVisible();
    const toc = dialog.getByRole('navigation', { name: 'Help contents' });
    await expect(toc.getByText('Readiness', { exact: true }).first()).toBeVisible();
    await dialog.getByRole('searchbox', { name: 'Search Bastion help' }).fill('auditor room');
    await expect(toc).not.toContainText('No matches.');
    // It is an overlay, not a page change.
    expect(new URL(page.url()).pathname).toBe('/bastion/');
    await dialog.getByRole('button', { name: 'Close help' }).click();
    await expect(dialog).toHaveCount(0);
  });
});
