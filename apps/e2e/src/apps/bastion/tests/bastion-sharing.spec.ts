import { test, expect } from '../../../fixtures/base.fixture';
import { DirectApiClient } from '../../../api/api-client';
import { readCsrfTokenFromCookies } from '../../../auth/auth.helper';
import type { APIRequestContext, Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import { auditCount, gilliganOrgId, id, outboxEvent, psql, userIdByEmail } from '../bastion-db';

// Bastion M9 user stories 8-11 (spec 11.4), against the GILLIGAN seed (SOC 2 and ISO 27001
// adopted, ISO physical-security requirements marked not applicable at M3):
//    8. Create an auditor room; the link is shown once; Preview lists controls, restricted items
//       and the Statement of Applicability.
//    9. An anonymous auditor (a fresh browser context with no session) views a control and an
//       evidence record; the access log grows.
//   10. After revoke, the room shows "This link is no longer available." and the public API 404s.
//   11. No raw UUID in the visible text of Readiness, Controls and a control detail page.
//
// Auth: the default authenticated context as Skipper (a cookie session: room create and revoke are
// session-only, spec 2.8). Self-cleaning: every room these stories create is revoked (story 10,
// and again in afterAll for a run that stopped early). The backend read-back is the API as the
// same user, then Postgres (bastion-db.ts, organization-scoped): the room row, its access-log
// rows, the auditor_room.created / auditor_room.revoked events' outbox rows, and the audit rows.

const SKIPPER = process.env.E2E_ADMIN_EMAIL || 'skipper@gilligantravel.example';
// The outbox drainer delivers within seconds; allow for a busy stack.
const DELIVERY = { timeout: 60_000, intervals: [500, 1_000, 2_000] };
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ROOM_GONE = 'This link is no longer available.';

interface Framework {
  id: string;
  template_key: string;
  name: string;
  status: string;
}
interface RoomRow {
  id: string;
  label: string;
  state: string;
  access_count: number;
  restricted_count: number;
}

async function makeApi(request: APIRequestContext, context: BrowserContext, base = '/bastion/api/v1'): Promise<DirectApiClient> {
  const csrf = readCsrfTokenFromCookies(await context.cookies()) || undefined;
  return new DirectApiClient(request, base, csrf);
}

/** A fresh, session-less browser context: what an outside auditor has. */
async function anonymousPage(browser: Browser, testInfo: TestInfo): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ baseURL: testInfo.project.use.baseURL, storageState: { cookies: [], origins: [] } });
  return { ctx, page: await ctx.newPage() };
}

const label = `Lagoon & Reef CPAs, story 8 ${Date.now()}`;
let roomId: string | null = null;
let token: string | null = null;
let restrictedTitle: string | null = null;

test.describe.serial('Bastion - auditor room and sharing (M9)', () => {
  test.afterAll(async ({ browser }, testInfo) => {
    if (!roomId) return;
    const ctx = await browser.newContext({ baseURL: testInfo.project.use.baseURL, storageState: testInfo.project.use.storageState as string });
    try {
      const api = await makeApi(ctx.request, ctx);
      await api.postRaw(`/auditor-rooms/${roomId}/revoke`, { confirm: true });
    } finally {
      await ctx.close();
    }
  });

  test('8. Create an auditor room; the link is shown once; Preview lists controls, restricted items and the SoA', async ({ page, request, context }) => {
    const api = await makeApi(request, context);
    const setup = (await api.getRaw('/setup')).body as { data: { frameworks: Framework[] } };
    const iso = setup.data.frameworks.find((f) => f.template_key === 'iso27001' && f.status !== 'archived');
    expect(iso, 'the GILLIGAN org has ISO 27001 adopted').toBeDefined();
    const evidence = (await api.getRaw('/manual-evidence', { status: 'active' })).body as { data: Array<{ id: string; title: string; sensitivity: string; masked?: boolean }> };
    restrictedTitle = evidence.data.find((e) => e.sensitivity === 'restricted' && !e.masked)?.title ?? null;

    await page.goto('/bastion/sharing');
    await page.getByRole('button', { name: 'Create auditor room' }).click();
    const form = page.getByTestId('create-room-form');
    await form.getByLabel('Who is this for?').fill(label);
    await form.getByLabel('Framework').selectOption(iso!.id);
    if (restrictedTitle) await form.getByLabel(restrictedTitle).check();
    await form.getByRole('button', { name: 'Create room' }).click();

    const once = page.getByTestId('room-link-once');
    await expect(once).toContainText('It is shown only once');
    const link = await page.getByTestId('room-link').inputValue();
    expect(link).toMatch(/\/bastion\/room#[A-Za-z0-9_-]{32,}$/);
    token = link.split('#')[1] ?? null;

    // The API never returns the token again.
    const rooms = (await api.getRaw('/auditor-rooms')).body as { data: Array<RoomRow & Record<string, unknown>> };
    const row = rooms.data.find((r) => r.label === label);
    expect(row).toBeDefined();
    roomId = row!.id;
    expect(row).not.toHaveProperty('token');
    expect(JSON.stringify(rooms)).not.toContain(token!);
    if (restrictedTitle) expect(row!.restricted_count).toBe(1);

    // A reload never shows the link again.
    await page.reload();
    await expect(page.getByTestId('room-link-once')).toHaveCount(0);
    await expect(page.getByText('It is shown only once')).toHaveCount(0);

    // Preview: what the auditor will see.
    const roomRow = page.getByTestId('room-row').filter({ hasText: label });
    await roomRow.getByRole('button', { name: 'Preview' }).click();
    const preview = roomRow.getByTestId('room-preview');
    await expect(preview).toContainText(label);
    await expect(preview.getByRole('heading', { name: 'Controls' })).toBeVisible();
    await expect(preview.getByTestId('room-soa')).toContainText('A.7.1');
    if (restrictedTitle) await expect(preview.getByTestId('room-restricted')).toContainText(restrictedTitle);
    const previewApi = (await api.getRaw(`/auditor-rooms/${roomId}/preview`)).body as { data: { controls: unknown[]; statement_of_applicability: Array<{ ref_code: string; applicable: string }> } };
    expect(previewApi.data.controls.length).toBeGreaterThan(0);
    expect(previewApi.data.statement_of_applicability.find((r) => r.ref_code === 'A.7.1')?.applicable).toBe('No');

    // Postgres: one open room for ISO 27001 created by Skipper, holding the token's hash only.
    const orgId = gilliganOrgId();
    const skipperId = userIdByEmail(SKIPPER);
    const rid = id(roomId);
    expect(
      psql(
        `SELECT framework_id || '|' || created_by || '|' || (revoked_at IS NULL) || '|' || coalesce(array_length(restricted_evidence_ids, 1), 0) || '|' || (coalesce(array_length(control_ids, 1), 0) > 0)
           FROM bastion_auditor_rooms WHERE organization_id = '${orgId}' AND id = '${rid}'`,
      ),
    ).toBe(`${id(iso!.id)}|${skipperId}|true|${restrictedTitle ? 1 : 0}|true`);
    // The plaintext token is stored nowhere on the row.
    expect(/^[A-Za-z0-9_-]+$/.test(token!)).toBe(true);
    expect(
      psql(`SELECT count(*) FROM bastion_auditor_rooms WHERE organization_id = '${orgId}' AND id = '${rid}' AND strpos(row_to_json(bastion_auditor_rooms)::text, '${token}') > 0`),
    ).toBe('0');
    await expect.poll(() => outboxEvent(orgId, 'auditor_room.created', rid), DELIVERY).toBe(`delivered|auditor_room.created|${skipperId}`);
    expect(auditCount(orgId, 'auditor_room.create', rid)).toBe(1);
  });

  test('9. An anonymous auditor views a control and evidence; the access log grows', async ({ browser, request, context }, testInfo) => {
    expect(token, 'story 8 created the room').not.toBeNull();
    const api = await makeApi(request, context);
    const before = ((await api.getRaw(`/auditor-rooms/${roomId}/access-log`)).body as { data: unknown[] }).data.length;

    const { ctx, page } = await anonymousPage(browser, testInfo);
    try {
      await page.goto(`/bastion/room#${token}`);
      await expect(page.getByRole('heading', { name: label })).toBeVisible();
      // Open the first control with any recorded evidence.
      const controls = page.getByTestId('room-view').locator('li button');
      const n = await controls.count();
      expect(n).toBeGreaterThan(0);
      let opened = false;
      for (let i = 0; i < n && !opened; i++) {
        await page.getByTestId('room-view').locator('li button').nth(i).click();
        await expect(page.getByTestId('room-control')).toBeVisible();
        const records = page.getByTestId('room-control').locator('li button');
        if ((await records.count()) > 0) {
          await records.first().click();
          await expect(page.getByTestId('room-evidence')).toBeVisible();
          opened = true;
        } else {
          await page.getByRole('button', { name: 'Back to all controls' }).click();
        }
      }
      expect(opened, 'at least one shared control has evidence in the period').toBe(true);
    } finally {
      await ctx.close();
    }

    const log = (await api.getRaw(`/auditor-rooms/${roomId}/access-log`)).body as { data: Array<{ view_kind: string }> };
    expect(log.data.length - before).toBeGreaterThanOrEqual(3);
    const kinds = new Set(log.data.map((r) => r.view_kind));
    for (const k of ['overview', 'control', 'evidence']) expect(kinds.has(k), k).toBe(true);
    const rooms = (await api.getRaw('/auditor-rooms')).body as { data: RoomRow[] };
    expect(rooms.data.find((r) => r.id === roomId)?.access_count).toBeGreaterThanOrEqual(3);

    // Postgres: the access-log rows for this room, every one with a fingerprint, never a raw address.
    const orgId = gilliganOrgId();
    const rid = id(roomId);
    const where = `organization_id = '${orgId}' AND room_id = '${rid}'`;
    expect(Number(psql(`SELECT count(*) FROM bastion_auditor_access_log WHERE ${where}`))).toBeGreaterThanOrEqual(Math.max(log.data.length, before + 3));
    expect(psql(`SELECT string_agg(DISTINCT view_kind, ',' ORDER BY view_kind) FROM bastion_auditor_access_log WHERE ${where} AND view_kind IN ('overview', 'control', 'evidence')`)).toBe(
      'control,evidence,overview',
    );
    expect(psql(`SELECT count(*) FROM bastion_auditor_access_log WHERE ${where} AND (ip_hash IS NULL OR ip_hash ~'^[0-9]{1,3}(\\.[0-9]{1,3}){3}$')`)).toBe('0');
    expect(Number(psql(`SELECT access_count FROM bastion_auditor_rooms WHERE organization_id = '${orgId}' AND id = '${rid}'`))).toBeGreaterThanOrEqual(3);
  });

  test('10. After revoke, "This link is no longer available." and 404', async ({ page, browser, request, context }, testInfo) => {
    expect(token).not.toBeNull();
    await page.goto('/bastion/sharing');
    const roomRow = page.getByTestId('room-row').filter({ hasText: label });
    await roomRow.getByRole('button', { name: 'Revoke', exact: true }).click();
    await roomRow.getByRole('button', { name: 'Revoke room' }).click();
    // #402: Sharing lists open rooms by default, so the revoked room leaves the list, and
    // Show closed rooms brings it back marked Revoked.
    await expect(roomRow).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Show closed rooms' }).check();
    await expect(roomRow).toContainText('Revoked');

    const api = await makeApi(request, context);
    const rooms = (await api.getRaw('/auditor-rooms')).body as { data: RoomRow[] };
    expect(rooms.data.find((r) => r.id === roomId)?.state).toBe('revoked');

    const { ctx, page: anon } = await anonymousPage(browser, testInfo);
    try {
      await anon.goto(`/bastion/room#${token}`);
      await expect(anon.getByTestId('room-gone')).toHaveText(ROOM_GONE);
    } finally {
      await ctx.close();
    }
    const direct = await request.get('/bastion/api/v1/public/room', { headers: { 'x-bastion-room-token': token! } });
    expect(direct.status()).toBe(404);

    // Postgres: the room is revoked, and the auditor_room.revoked event's outbox row delivers.
    const orgId = gilliganOrgId();
    const skipperId = userIdByEmail(SKIPPER);
    const rid = id(roomId);
    expect(psql(`SELECT revoked_at IS NOT NULL FROM bastion_auditor_rooms WHERE organization_id = '${orgId}' AND id = '${rid}'`)).toBe('t');
    await expect.poll(() => outboxEvent(orgId, 'auditor_room.revoked', rid), DELIVERY).toBe(`delivered|auditor_room.revoked|${skipperId}`);
    expect(
      psql(`SELECT payload->'payload'->>'reason' FROM bastion_outbox WHERE organization_id = '${orgId}' AND idempotency_key = 'event:auditor_room.revoked:${rid}'`),
    ).toBe('revoked');
    expect(auditCount(orgId, 'auditor_room.revoke', rid)).toBe(1);
    roomId = null;
  });

  test('11. No raw UUID on Readiness, Controls or a control detail page', async ({ page, request, context }) => {
    const api = await makeApi(request, context);
    const controls = (await api.getRaw('/controls')).body as { data: Array<{ id: string }> };
    const first = controls.data[0];
    expect(first).toBeDefined();
    for (const path of ['/bastion/', '/bastion/controls', `/bastion/controls/${first!.id}`]) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      const text = await page.evaluate(() => document.body.innerText);
      expect(text, path).not.toMatch(UUID_RE);
    }
  });
});
