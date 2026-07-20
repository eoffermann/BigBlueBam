import path from 'node:path';
import { test, expect } from '../../../fixtures/base.fixture';
import { DirectApiClient } from '../../../api/api-client';
import { readCsrfTokenFromCookies } from '../../../auth/auth.helper';
import type { APIRequestContext, BrowserContext } from '@playwright/test';

// Burn user-story E2E: the AI pre-transaction spend gate. Runs against the
// already-seeded gilligan org, where the "Castaway Rescue Platform SOW"
// engagement (scoped to the Island Infrastructure project) carries one
// confirmed, priced, active deliverable — "Rescue Beacon Buildout", a fixed
// $5,000 envelope. That confirmed envelope is what the flagship gate enforces
// against: an over-envelope bill.expense is denied before it posts, and the
// gate always fails OPEN when burn-api is unavailable.
//
// Auth: the default authenticated context (.auth/admin.json). Run the setup
// with E2E_ADMIN_EMAIL=skipper@gilligantravel.example so the session carries
// the burn.* permissions granted to the gilligan Owner group. The negative
// stories use .auth/member.json (E2E_MEMBER_EMAIL=professor@gilligantravel.example),
// a gilligan org member who is NOT a member of the Island Infrastructure
// project the engagement is scoped to.
//
// Read-only: every story asserts against seeded state; none of them create an
// engagement, deliverable, precheck, or cost rate, so re-runs stay
// deterministic.

// Seeded facts (verified against the live DB in the gilligan org).
const ENGAGEMENT_TITLE = 'Castaway Rescue Platform SOW';
const DELIVERABLE_TITLE = 'Rescue Beacon Buildout';
const MEMBER_STATE = path.join(__dirname, '..', '..', '..', '..', '.auth', 'member.json');

interface BurnEngagementRow {
  id: string;
  title: string;
  chain_root_id: string;
  status: string;
  envelope_basis: string;
}
interface BurnSettingsRow {
  gate_mode: string;
  gate_enabled_refs: string[];
  deny_threshold: string | number;
}
interface BurnDeliverableRow {
  id: string;
  title: string;
  review_status: string;
  is_active: boolean;
  envelope_source: string;
}

// Build a Burn-scoped API client sharing the browser session + CSRF token,
// mirroring how the base fixture builds the b3 client but pointed at /burn/api/v1.
async function makeBurnApi(
  request: APIRequestContext,
  context: BrowserContext,
): Promise<DirectApiClient> {
  const cookies = await context.cookies();
  const csrf = readCsrfTokenFromCookies(cookies) || undefined;
  return new DirectApiClient(request, '/burn/api/v1', csrf);
}

test.describe('Burn — AI pre-transaction spend gate', () => {
  // Story 1: Portfolio Board. The board renders and the seeded engagement chain
  // is listed; the backend confirms GET /engagements returns the SOW with a
  // fixed envelope basis and active status.
  test('lists the seeded engagement on the Portfolio Board', async ({
    page,
    request,
    context,
  }) => {
    await page.goto('/burn/');

    await expect(page.getByRole('heading', { name: 'Portfolio Board' })).toBeVisible();
    // The "No engagements yet" empty state must NOT be shown; the seeded chain
    // card renders with the engagement title.
    await expect(page.getByText('No engagements yet')).toHaveCount(0);
    await expect(page.getByText(ENGAGEMENT_TITLE).first()).toBeVisible();

    // Backend: GET /engagements → the seeded SOW, fixed envelope basis, active.
    const burn = await makeBurnApi(request, context);
    const res = await burn.get<{ data: BurnEngagementRow[] } | BurnEngagementRow[]>('/engagements');
    const rows = Array.isArray(res) ? res : res.data;
    const eng = rows.find((e) => e.title === ENGAGEMENT_TITLE);
    expect(eng, 'seeded Castaway Rescue Platform SOW should be returned').toBeTruthy();
    expect(eng!.status).toBe('active');
    expect(eng!.envelope_basis).toBe('fixed');

    // The engagement's confirmed, priced, active deliverable is the enforceable
    // envelope. GET /engagements/:id/deliverables surfaces it.
    const dres = await burn.get<{ data: BurnDeliverableRow[] } | BurnDeliverableRow[]>(
      '/deliverables',
      { 'filter[engagement_id]': eng!.id },
    );
    const drows = Array.isArray(dres) ? dres : dres.data;
    const deliverable = drows.find((d) => d.title === DELIVERABLE_TITLE);
    expect(deliverable, 'the Rescue Beacon Buildout deliverable should exist').toBeTruthy();
    expect(deliverable!.review_status).toBe('confirmed');
    expect(deliverable!.is_active).toBe(true);
    expect(deliverable!.envelope_source).toBe('human');
  });

  // Story 2: Register engagement. The owner holds burn.engagement.write, so the
  // "Register engagement" control is present and opening it reveals the
  // registration form (not a 403 / restricted state).
  test('opens the register-engagement form for a writer', async ({ page }) => {
    await page.goto('/burn/');
    await expect(page.getByRole('heading', { name: 'Portfolio Board' })).toBeVisible();

    const registerBtn = page.getByRole('button', { name: /Register engagement/ }).first();
    await expect(registerBtn).toBeVisible();
    await registerBtn.click();

    // The form's title input (placeholder mirrors the seeded SOW) is the stable
    // affordance. The button is gated on burn.engagement.write; a member would
    // never see it.
    await expect(
      page.getByPlaceholder('e.g. Castaway Rescue Platform SOW'),
    ).toBeVisible();
  });

  // Story 3: Gate Console. The console renders and shows the org's current gate
  // mode; the backend confirms GET /settings returns a gate_mode with
  // bill.expense among the enabled classes (the flagship money-out class).
  test('renders the Gate Console with the org gate mode', async ({ page, request, context }) => {
    await page.goto('/burn/gate');
    await expect(page.getByRole('heading', { name: 'Gate Console' })).toBeVisible();
    // The three mode controls render.
    await expect(page.getByText('Advisory').first()).toBeVisible();
    await expect(page.getByText('Blocking').first()).toBeVisible();

    const burn = await makeBurnApi(request, context);
    const res = await burn.get<{ data: BurnSettingsRow } | BurnSettingsRow>('/settings');
    const settings = 'data' in (res as object) ? (res as { data: BurnSettingsRow }).data : (res as BurnSettingsRow);
    expect(['off', 'advisory', 'blocking']).toContain(settings.gate_mode);
    expect(settings.gate_enabled_refs).toContain('bill.expense');
  });

  // Story 4: Unscoped Queue and Variances. Both operational review surfaces load
  // to their headings (they may be empty; the assertion is that the page mounts,
  // not that there is drift).
  test('loads the Unscoped Queue and Variances surfaces', async ({ page }) => {
    await page.goto('/burn/unscoped');
    await expect(page.getByRole('heading', { name: 'Unscoped Queue' })).toBeVisible();

    await page.goto('/burn/variances');
    await expect(page.getByRole('heading', { name: 'Variances & Change Orders' })).toBeVisible();
  });

  // Story 5: Cost Rates gated. The owner holds burn.costrate.read, so the Cost
  // Rates page renders its heading (not the "Restricted" state). The member
  // negative case is Story 6c.
  test('shows Cost Rates to a permitted admin', async ({ page }) => {
    await page.goto('/burn/settings/cost-rates');
    await expect(page.getByRole('heading', { name: 'Cost Rates' })).toBeVisible();
    // The restricted branch (a member) renders "Cost rates are owner/admin
    // only" in place of the rate surface. The owner holds burn.costrate.read, so
    // the real surface renders (its subtitle is the stable marker) and the
    // restricted copy is absent.
    await expect(page.getByText(/Effective-dated cost per person/)).toBeVisible();
    await expect(page.getByText(/Cost rates are owner\/admin only/)).toHaveCount(0);
  });

  // Story 6: Negative / project-scope + permission gating. The Professor is a
  // gilligan org member but NOT a member of the Island Infrastructure project
  // the engagement is scoped to, so the board hides the SOW entirely (fail
  // closed), the API returns it in neither list, and the Cost Rates surface is
  // restricted. Uses the member storage state; no state is mutated.
  test('gates the engagement and cost rates from a non-project member', async ({ browser }) => {
    const memberContext = await browser.newContext({ storageState: MEMBER_STATE });
    try {
      const memberPage = await memberContext.newPage();

      // 6a. Portfolio Board: the SOW must NOT be listed for the Professor.
      await memberPage.goto('/burn/');
      await expect(memberPage.getByRole('heading', { name: 'Portfolio Board' })).toBeVisible();
      await expect(memberPage.getByText(ENGAGEMENT_TITLE)).toHaveCount(0);

      // 6b. Backend: GET /engagements as the member → the SOW is absent. Use the
      // member CONTEXT's own request handle so the call carries the Professor's
      // session cookies.
      const memberCookies = await memberContext.cookies();
      const memberCsrf = readCsrfTokenFromCookies(memberCookies) || undefined;
      const memberApi = new DirectApiClient(memberContext.request, '/burn/api/v1', memberCsrf);
      const res = await memberApi.get<{ data: BurnEngagementRow[] } | BurnEngagementRow[]>('/engagements');
      const rows = Array.isArray(res) ? res : res.data;
      expect(rows.find((e) => e.title === ENGAGEMENT_TITLE)).toBeUndefined();

      // 6c. Cost Rates is gated by burn.costrate.read, which a member lacks: the
      // page shows the owner/admin-only notice rather than the rate table, and
      // the API returns 403 PERMISSION_DENIED.
      await memberPage.goto('/burn/settings/cost-rates');
      await expect(
        memberPage.getByText(/Cost rates are owner\/admin only/),
      ).toBeVisible();
      const rateRes = await memberContext.request.get('/burn/api/v1/cost-rates');
      expect(rateRes.status()).toBe(403);
    } finally {
      await memberContext.close();
    }
  });
});
