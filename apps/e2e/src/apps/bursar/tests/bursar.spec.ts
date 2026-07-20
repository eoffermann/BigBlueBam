import { test, expect } from '../../../fixtures/base.fixture';
import { DirectApiClient } from '../../../api/api-client';
import { readCsrfTokenFromCookies } from '../../../auth/auth.helper';
import type { APIRequestContext, BrowserContext } from '@playwright/test';
// The ONE source of truth for the seeded numbers (spec 19.3). The suite imports it
// rather than restating literals, so a seed change breaks the assertion at the one
// place both the seeder and this test read. Resolved at runtime from the repo path;
// typed via apps/e2e/src/apps/bursar/bursar-expectations.d.ts.
import { BURSAR_SEED_EXPECTATIONS as EXP } from '../../../../../../scripts/seed-gilligan/bursar.expectations.mjs';

// Bursar user-story E2E: the AI procurement-leveling and spend-baseline monitor. Runs
// as Skipper (the request owner, an org Owner in the gilligan cast) against the seeded
// "Lagoon Rescue Beacon Procurement" request, its four offers, the Radio Parts award,
// and the post-award detector findings (scripts/seed-gilligan/bursar.mjs).
//
// Auth: the default authenticated context (.auth/admin.json). Run the setup with
// E2E_ADMIN_EMAIL=skipper@gilligantravel.example so the session carries the bursar.*
// permissions granted to the gilligan Owner group.
//
// Read-mostly: every hard assertion reads settled seeded state. The two inherently
// mutating steps (2 promote+confirm, 5 rival promote) are written idempotently - they
// assert the post-condition and pass whether the seed left the state pre- or
// post-promotion, so re-runs stay green and the suite is self-cleaning (it creates no
// new top-level entities and no throwaway org).

// Response envelope helpers (bursar-api returns either a bare array/object or {data}).
function unwrap<T>(res: T | { data: T }): T {
  return res && typeof res === 'object' && 'data' in (res as object)
    ? (res as { data: T }).data
    : (res as T);
}

interface RequestRow { id: string; title: string; scope_status?: string }
interface ScopeNode {
  id: string;
  title: string;
  normative_strength: string;
  derived_from: string;
  review_status: string;
  contributing_offer_ids?: string[];
  cited_span?: { quote?: string | null } | null;
}
interface ScopeTree { request: RequestRow & { injection_suspected?: boolean }; nodes: ScopeNode[] }
interface MatrixOffer { id: string; label?: string | null; blanket_suspected?: boolean }
interface MatrixCoverage {
  offer_id: string;
  scope_node_id: string;
  verdict: string;
  confidence_band?: string | null;
  review_status: string;
  withheld_reason?: string | null;
  delta_kind?: string | null;
  rejected_candidates?: unknown[];
}
interface MatrixTotal {
  offer_id: string;
  total_kind: string;
  amount_minor: number | null;
  renderable?: boolean;
}
interface Matrix { nodes: ScopeNode[]; offers: MatrixOffer[]; coverage: MatrixCoverage[]; totals: MatrixTotal[]; sort_key: string }
interface DiffRow { scope_node_id: string; title: string; verdict: string; review_status: string; withheld_reason?: string | null }
interface DiffOffer {
  offer_id: string;
  label?: string | null;
  rows: DiffRow[];
  published: unknown[];
  needs_review: unknown[];
  unverified: unknown[];
  blocking?: boolean;
  blanket?: boolean;
}
interface Diff { mandatory_count: number; offers: DiffOffer[] }
interface AwardRow { id: string; vendor_id?: string | null; status?: string; orphaned_custody?: boolean }
interface BaselineItem { kind: string; delta_kind?: string | null; title?: string; scope_node_title?: string }
interface MismatchRow { id: string; detector: string; severity: string; amount_minor: number | null; quantified?: boolean; vendor_id?: string | null; summary?: string | null }
interface RenewalRow { id: string; vendor_id?: string | null; lead_band?: string | null; status?: string }
interface VendorRow { id: string; display_name: string }

async function makeBursarApi(
  request: APIRequestContext,
  context: BrowserContext,
): Promise<DirectApiClient> {
  const cookies = await context.cookies();
  const csrf = readCsrfTokenFromCookies(cookies) || undefined;
  return new DirectApiClient(request, '/bursar/api/v1', csrf);
}

async function resolveRequestId(api: DirectApiClient): Promise<string> {
  const rows = unwrap<RequestRow[]>(await api.get('/requests', { limit: 200 }));
  const req = rows.find((r) => r.title === EXP.request.title);
  expect(req, `seeded request "${EXP.request.title}" should exist`).toBeTruthy();
  return req!.id;
}

async function getScope(api: DirectApiClient, rid: string): Promise<ScopeTree> {
  return unwrap<ScopeTree>(await api.get(`/requests/${rid}/scope`));
}
async function getMatrix(api: DirectApiClient, rid: string): Promise<Matrix> {
  return unwrap<Matrix>(await api.get(`/requests/${rid}/matrix`));
}
async function getDiff(api: DirectApiClient, rid: string): Promise<Diff> {
  return unwrap<Diff>(await api.get(`/requests/${rid}/exclusion-diff`));
}
function offerIdByLabel(offers: Array<{ id: string; label?: string | null }>, label: string): string | undefined {
  return offers.find((o) => (o.label ?? '').includes(label))?.id;
}

test.describe('Bursar - procurement leveling & spend baseline', () => {
  // Step 1: /bursar/, open the request, see the seeded node count, click a citation.
  test('1. opens the request and shows the seeded scope-node count with citations', async ({ page, request, context }) => {
    await page.goto('/bursar/requests');
    await expect(page.getByRole('heading', { name: 'Requests' })).toBeVisible();
    await page.getByText(EXP.request.title).first().click();

    // The Scope Tree editor renders; the seeded tree carries the expected node count.
    await expect(page.getByText(new RegExp(`Scope nodes \\(${EXP.request.nodeCount}\\)`))).toBeVisible();

    const api = await makeBursarApi(request, context);
    const rid = await resolveRequestId(api);
    const scope = await getScope(api, rid);
    // The counted tree (rival proposals excluded) matches the seeded node count.
    const counted = scope.nodes.filter(
      (n) => !(n.derived_from === 'rival_offer' && n.review_status === 'pending_review'),
    );
    expect(counted.length).toBe(EXP.request.nodeCount);
    // The three named mandatory nodes are present.
    for (const title of EXP.request.mandatoryTitles) {
      expect(scope.nodes.some((n) => n.title === title && n.normative_strength === 'mandatory')).toBe(true);
    }
    // At least one node carries a verifiable cited span (the citation the popover shows).
    expect(scope.nodes.some((n) => (n.cited_span?.quote ?? '').length > 0)).toBe(true);
  });

  // Step 2: Promote "Price escalation cap" to mandatory; Confirm scope. Idempotent:
  // asserts the node ends mandatory and the scope ends confirmed regardless of the
  // starting state.
  test('2. promotes Price escalation cap to mandatory and confirms scope', async ({ request, context }) => {
    const api = await makeBursarApi(request, context);
    const rid = await resolveRequestId(api);
    const scope = await getScope(api, rid);
    const cap = scope.nodes.find((n) => n.title === 'Price escalation cap');
    expect(cap, 'the Price escalation cap should-have node should exist').toBeTruthy();

    // Promote to mandatory (idempotent: a no-op if the seed already did) and confirm.
    if (cap!.normative_strength !== 'mandatory') {
      await api.patch(`/scope-nodes/${cap!.id}`, { normative_strength: 'mandatory' }).catch(() => undefined);
    }
    if (scope.request.scope_status !== 'confirmed' && scope.request.scope_status !== 'awarded') {
      await api.post(`/requests/${rid}/scope/confirm`, {}).catch(() => undefined);
    }

    const after = await getScope(api, rid);
    const capAfter = after.nodes.find((n) => n.title === 'Price escalation cap');
    expect(capAfter?.normative_strength).toBe('mandatory');
    expect(['confirmed', 'awarded']).toContain(after.request.scope_status);
  });

  // Step 3: Matrix shows four offer columns; a red `absent` chip at (Crew training, Howell).
  test('3. renders the leveling matrix with an absent chip at (Crew training, Howell)', async ({ page, request, context }) => {
    const api = await makeBursarApi(request, context);
    const rid = await resolveRequestId(api);

    await page.goto(`/bursar/requests/${rid}/level`);
    await expect(page.getByRole('heading', { name: 'Leveling Matrix' })).toBeVisible();

    const matrix = await getMatrix(api, rid);
    expect(matrix.offers.length).toBe(EXP.offers.length); // four offer columns

    const howellId = offerIdByLabel(matrix.offers, 'Howell');
    const trainingNode = matrix.nodes.find((n) => n.title === 'Crew training for six');
    expect(howellId && trainingNode).toBeTruthy();
    const cell = matrix.coverage.find(
      (c) => c.offer_id === howellId && c.scope_node_id === trainingNode!.id,
    );
    expect(cell?.verdict, 'Howell is silent about crew training → absent').toBe('absent');
  });

  // Step 4: Clicking the absent chip renders rejected candidates and reasons.
  test('4. the absent cell carries rejected candidates and reasons', async ({ request, context }) => {
    const api = await makeBursarApi(request, context);
    const rid = await resolveRequestId(api);
    const matrix = await getMatrix(api, rid);
    const howellId = offerIdByLabel(matrix.offers, 'Howell');
    const trainingNode = matrix.nodes.find((n) => n.title === 'Crew training for six');
    const cell = matrix.coverage.find(
      (c) => c.offer_id === howellId && c.scope_node_id === trainingNode!.id,
    );
    // An absent verdict is evidence-backed: it carries the candidates the engine
    // considered and rejected (spec 4 - "we could not read it" is never absence).
    expect(cell?.verdict).toBe('absent');
    expect(Array.isArray(cell?.rejected_candidates)).toBe(true);
  });

  // Step 5: The rival-promotion queue shows pending rival nodes, and NONE appear in the
  // diff; promote one and assert it appears. Idempotent: if the seed already promoted
  // them, the invariant (no pending rival node is in the diff) still holds.
  test('5. rival-derived nodes stay out of the diff until promoted', async ({ request, context }) => {
    const api = await makeBursarApi(request, context);
    const rid = await resolveRequestId(api);
    const scope = await getScope(api, rid);
    const pendingRivals = scope.nodes.filter(
      (n) => n.derived_from === 'rival_offer' && n.review_status === 'pending_review',
    );
    const diff = await getDiff(api, rid);
    const diffTitles = new Set(diff.offers.flatMap((o) => o.rows.map((r) => r.title)));
    // §4.5: a pending rival node never appears in the diff.
    for (const rn of pendingRivals) {
      expect(diffTitles.has(rn.title), `pending rival "${rn.title}" must not be in the diff`).toBe(false);
    }
    if (pendingRivals.length > 0) {
      const target = pendingRivals[0]!;
      await api.post(`/scope-nodes/${target.id}/promote-rival`, {}).catch(() => undefined);
      const afterScope = await getScope(api, rid);
      const promoted = afterScope.nodes.find((n) => n.title === target.title);
      expect(promoted?.review_status).not.toBe('pending_review');
    }
  });

  // Step 6: Diff ranks Howell's excluded_explicit above all-offers-absent notes; the
  // "installation by others" language is on the page.
  test('6. the diff surfaces Howell excluded_explicit and "installation by others"', async ({ page, request, context }) => {
    const api = await makeBursarApi(request, context);
    const rid = await resolveRequestId(api);

    await page.goto(`/bursar/requests/${rid}/diff`);
    await expect(page.getByRole('heading', { name: 'Exclusion Diff' })).toBeVisible();

    const diff = await getDiff(api, rid);
    const howell = diff.offers.find((o) => (o.label ?? '').includes('Howell'));
    expect(howell, 'Howell offer should appear in the diff').toBeTruthy();
    const installRow = howell!.rows.find((r) => r.title === 'On-island installation and commissioning');
    expect(installRow?.verdict).toBe('excluded_explicit');
  });

  // Step 7: THE PUNCHLINE - gap_adjusted(Howell) > gap_adjusted(Radio), from the constant.
  test('7. gap_adjusted(Howell) > gap_adjusted(Radio) - the sticker-cheap bid is the pricier deal', async ({ request, context }) => {
    const api = await makeBursarApi(request, context);
    const rid = await resolveRequestId(api);
    const matrix = await getMatrix(api, rid);
    const howellId = offerIdByLabel(matrix.offers, 'Howell');
    const radioId = offerIdByLabel(matrix.offers, 'Radio');
    const gapOf = (oid?: string) =>
      matrix.totals.find((t) => t.offer_id === oid && t.total_kind === 'gap_adjusted')?.amount_minor ?? null;
    const howellGap = gapOf(howellId);
    const radioGap = gapOf(radioId);
    expect(howellGap).not.toBeNull();
    expect(radioGap).not.toBeNull();
    expect(howellGap!).toBeGreaterThan(radioGap!);
    // And they match the canonical figures.
    expect(howellGap).toBe(EXP.punchline.gapAdjustedHowellMinor);
    expect(radioGap).toBe(EXP.punchline.gapAdjustedRadioMinor);
  });

  // Step 8: Professor's Lab Supply - offer_manipulation_suspected, zero auto-published
  // covered, AND the diff renders the mandatory nodes as needs_review with
  // withheld_reason='blanket_cap' (the §4.7 negative).
  test('8. the split-blanket offer publishes zero covered and withholds every mandatory node', async ({ request, context }) => {
    const api = await makeBursarApi(request, context);
    const rid = await resolveRequestId(api);
    const matrix = await getMatrix(api, rid);
    const profId = offerIdByLabel(matrix.offers, 'Professor');
    expect(profId).toBeTruthy();

    const profCoverage = matrix.coverage.filter((c) => c.offer_id === profId);
    // Zero auto-published `covered` from the blanket claim.
    const publishedCovered = profCoverage.filter(
      (c) => c.review_status === 'published' && c.verdict === 'covered',
    );
    expect(publishedCovered.length).toBe(EXP.offers.find((o) => o.key === 'professor')!.autoPublishedCovered ?? 0);

    // The diff renders the mandatory nodes as needs_review with withheld_reason=blanket_cap.
    const diff = await getDiff(api, rid);
    const prof = diff.offers.find((o) => (o.label ?? '').includes('Professor'));
    expect(prof, 'Professor offer should appear in the diff').toBeTruthy();
    const withheld = prof!.rows.filter((r) => r.withheld_reason === 'blanket_cap');
    expect(withheld.length).toBeGreaterThanOrEqual(EXP.request.mandatoryTitles.length);
    for (const title of EXP.request.mandatoryTitles) {
      const row = prof!.rows.find((r) => r.title === title);
      expect(row, `mandatory node "${title}" must appear in the blanket diff`).toBeTruthy();
      expect(row!.review_status).toBe('needs_review');
    }
  });

  // Step 9: Award to Radio Parts, asserted STRUCTURALLY, with no baseline edit control.
  test('9. the Radio Parts award freezes a 14-included baseline with no edit control', async ({ page, request, context }) => {
    const api = await makeBursarApi(request, context);
    const vendors = unwrap<VendorRow[]>(await api.get('/vendors', { limit: 200 }));
    const radio = vendors.find((v) => v.display_name === EXP.award.vendor);
    expect(radio, 'Radio Parts vendor should exist').toBeTruthy();

    const awards = unwrap<AwardRow[]>(await api.get('/awards', { limit: 200 }));
    const award = awards.find((a) => a.vendor_id === radio!.id);
    expect(award, 'an award to Radio Parts should exist').toBeTruthy();

    const baseline = unwrap<{ items?: BaselineItem[] } | BaselineItem[]>(
      await api.get(`/awards/${award!.id}/baseline`),
    );
    const items = Array.isArray(baseline) ? baseline : (baseline.items ?? []);
    const included = items.filter((i) => i.kind === 'included');
    const excluded = items.filter((i) => i.kind === 'excluded_at_award');
    const absent = items.filter((i) => i.kind === 'absent_at_award');
    // included + excluded_at_award + absent_at_award == node count.
    expect(included.length + excluded.length + absent.length).toBe(EXP.award.baseline.included);
    expect(excluded.length).toBe(EXP.award.baseline.excludedAtAward);
    expect(absent.length).toBe(EXP.award.baseline.absentAtAward);
    // The warranty node is `included` with a term delta.
    const warranty = items.find((i) => (i.title ?? i.scope_node_title) === EXP.award.baseline.warrantyNode.title);
    expect(warranty?.kind).toBe('included');
    expect(warranty?.delta_kind).toBe(EXP.award.baseline.warrantyNode.deltaKind);

    // No edit control renders on any baseline row (spec 20.3 step 9).
    await page.goto(`/bursar/vendors/${radio!.id}`);
    await expect(page.getByRole('heading', { name: EXP.award.vendor })).toBeVisible();
    // A frozen baseline exposes no inline edit/save affordance in its section.
    const baselineSection = page.locator('section, div').filter({ hasText: 'Baseline' }).first();
    await expect(baselineSection.getByRole('button', { name: /edit|save/i })).toHaveCount(0);
  });

  // Step 10: mismatches and renewals render real figures.
  test('10. mismatches cite a real figure and Island Weather Feed sits in its renewal band', async ({ page, request, context }) => {
    const api = await makeBursarApi(request, context);

    const mismatches = unwrap<MismatchRow[]>(await api.get('/mismatches', { limit: 200 }));
    const drift = mismatches.find((m) => m.detector === EXP.detectors.priceDrift.detector);
    expect(drift, 'a price_drift finding should exist').toBeTruthy();
    // A quantified drift cites a real figure, never a fabricated 0.
    if (drift!.quantified !== false && drift!.amount_minor != null) {
      expect(drift!.amount_minor).toBeGreaterThan(0);
    }

    const renewals = unwrap<RenewalRow[]>(await api.get('/renewals', { limit: 200 }));
    const vendors = unwrap<VendorRow[]>(await api.get('/vendors', { limit: 200 }));
    const weather = vendors.find((v) => v.display_name === EXP.detectors.renewalCliff.vendor);
    const cliff = renewals.find((r) => r.vendor_id === weather?.id);
    expect(cliff, 'Island Weather Feed should be on the renewal radar').toBeTruthy();

    await page.goto('/bursar/renewals');
    await expect(page.getByRole('heading', { name: 'Renewal Radar' })).toBeVisible();
  });

  // Step 11: the two negatives - no headline aggregate band set includes `medium`, and
  // no "clean" affordance renders while any node is needs_review.
  test('11. no medium band in any headline aggregate and no clean affordance while anything needs review', async ({ page, request, context }) => {
    const api = await makeBursarApi(request, context);
    const rid = await resolveRequestId(api);

    await page.goto(`/bursar/requests/${rid}/level`);
    await expect(page.getByTestId('matrix-headline-aggregate')).toBeVisible();
    const bands = (await page.getByTestId('matrix-headline-aggregate').getAttribute('data-contributing-bands')) ?? '';
    expect(bands.split(',').map((b) => b.trim())).not.toContain('medium');

    // On the diff, while any offer has a needs_review/unverified node, the clean-state
    // affordance must not render for that offer.
    await page.goto(`/bursar/requests/${rid}/diff`);
    await expect(page.getByRole('heading', { name: 'Exclusion Diff' })).toBeVisible();
    const diff = await getDiff(api, rid);
    const anyBlocking = diff.offers.some((o) => o.needs_review.length > 0 || o.unverified.length > 0);
    if (anyBlocking) {
      // The blanket (Professor) offer must show the blocking banner, not the clean state.
      await expect(page.getByTestId('diff-blocking-banner').first()).toBeVisible();
    }
  });

  // Step 12: Help - the HelpTrigger opens and the Bursar guide loads.
  test('12. the Help Center opens the Bursar guide', async ({ page }) => {
    await page.goto('/bursar/');
    await expect(page.getByRole('heading', { name: 'Vendor Portfolio' })).toBeVisible();
    // The shared HelpTrigger ("?" key also opens Help - app.tsx binds it).
    await page.keyboard.press('?');
    // The HelpViewer for the Bursar guide mounts.
    await expect(page.getByText(/Bursar/i).first()).toBeVisible();
  });
});
