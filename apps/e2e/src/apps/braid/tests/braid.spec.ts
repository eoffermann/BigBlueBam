import { test, expect } from '../../../fixtures/base.fixture';
import { DirectApiClient, ApiClientError } from '../../../api/api-client';
import { readCsrfTokenFromCookies } from '../../../auth/auth.helper';
import type { APIRequestContext, BrowserContext } from '@playwright/test';

// Braid user-story E2E: identity resolution and golden records. Runs against the
// already-seeded gilligan org, where a golden profile (skipper@gilligan.example,
// 3 book.event_attendee identities, confidence 0.95), a second profile
// ("Jonas Grumby"), and one pending ~86% merge candidate exist. Uses the default
// authenticated context (.auth/admin.json). The setup project logs the admin in;
// run this suite with E2E_ADMIN_EMAIL=skipper@gilligantravel.example so the
// session carries the braid.* permissions granted to the gilligan Owner group.
//
// Self-cleaning: every story below is a read-only assertion against seeded data
// except story 5, whose PATCH deliberately fails validation before any write, so
// no persisted state is mutated and re-runs stay deterministic.

// Seeded facts (verified against the live DB in the gilligan org).
const GOLDEN_EMAIL = 'skipper@gilligan.example';

// Build a Braid-scoped API client sharing the browser session + CSRF token,
// mirroring how the base fixture builds the b3 client but pointed at /braid/api/v1.
async function makeBraidApi(
  request: APIRequestContext,
  context: BrowserContext,
): Promise<DirectApiClient> {
  const cookies = await context.cookies();
  const csrf = readCsrfTokenFromCookies(cookies) || undefined;
  return new DirectApiClient(request, '/braid/api/v1', csrf);
}

interface BraidProfileRow {
  id: string;
  kind: 'person' | 'company';
  display_name: string | null;
  primary_email: string | null;
  identity_count: number;
  confidence: number | null;
  status: string;
}

interface BraidCandidateRow {
  id: string;
  profile_a_id: string;
  profile_b_id: string;
  score: number;
  status: string;
  rationale: string | null;
}

test.describe('Braid — identity resolution and golden records', () => {
  // Story 1: Happy path catalog. The Profiles table renders and shows the
  // Skipper golden profile row; the REST API confirms at least one profile.
  test('lists golden profiles and surfaces the Skipper golden record', async ({
    page,
    request,
    context,
  }) => {
    await page.goto('/braid/');
    await expect(page.getByRole('heading', { name: 'Golden profiles' })).toBeVisible();

    // The golden profile has no display_name (renders "(unnamed)"); it is
    // identified by its primary email, 3 identities, and 95% confidence.
    const goldenRow = page.getByRole('row', { name: new RegExp(GOLDEN_EMAIL) });
    await expect(goldenRow).toBeVisible();
    await expect(goldenRow.getByRole('cell', { name: '3', exact: true })).toBeVisible();
    await expect(goldenRow.getByRole('cell', { name: '95%', exact: true })).toBeVisible();

    // Backend: GET /braid/api/v1/profiles → 200 with >= 1 profile, including
    // the Skipper golden record with its 3 identities and 0.95 confidence.
    const braid = await makeBraidApi(request, context);
    const profiles = await braid.get<BraidProfileRow[]>('/profiles');
    expect(Array.isArray(profiles)).toBe(true);
    expect(profiles.length).toBeGreaterThanOrEqual(1);
    const golden = profiles.find((p) => p.primary_email === GOLDEN_EMAIL);
    expect(golden, 'seeded Skipper golden profile should be returned').toBeTruthy();
    expect(golden!.identity_count).toBe(3);
    expect(golden!.confidence).toBeCloseTo(0.95, 2);
  });

  // Story 2: Detail. Opening the golden profile shows its 3 member identities
  // (all book.event_attendee) and the timeline / decisions sections render.
  test('opens the golden profile detail and shows its member identities', async ({
    page,
    request,
    context,
  }) => {
    // Resolve the golden id from the API so we do not hardcode a UUID.
    const braid = await makeBraidApi(request, context);
    const profiles = await braid.get<BraidProfileRow[]>('/profiles');
    const golden = profiles.find((p) => p.primary_email === GOLDEN_EMAIL);
    expect(golden, 'seeded Skipper golden profile should exist').toBeTruthy();

    await page.goto('/braid/');
    await page.getByRole('row', { name: new RegExp(GOLDEN_EMAIL) }).click();

    // Header: identity count and confidence.
    await expect(page.getByText('3 linked identities')).toBeVisible();
    await expect(page.getByText(/Confidence:\s*95%/)).toBeVisible();

    // Member identities: 3 rows, each a book.event_attendee source badge.
    await expect(page.getByRole('heading', { name: 'Member identities' })).toBeVisible();
    await expect(page.getByText('book.event_attendee')).toHaveCount(3);

    // Timeline + decisions sections render.
    await expect(page.getByRole('heading', { name: 'Cross-app timeline' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Decisions & audit' })).toBeVisible();

    // Backend: the identities endpoint returns exactly 3 book.event_attendee rows.
    const identities = await braid.get<Array<{ source_type: string }>>(
      `/profiles/${golden!.id}/identities`,
    );
    expect(identities).toHaveLength(3);
    expect(identities.every((i) => i.source_type === 'book.event_attendee')).toBe(true);
  });

  // Story 3: Review queue. The pending ~86% merge candidate is listed with its
  // score, an Evidence affordance, and Confirm / Reject controls. Read-only: we
  // expand Evidence but never Confirm or Reject (those would mutate state).
  test('shows the pending merge candidate with evidence and decision controls', async ({
    page,
    request,
    context,
  }) => {
    // Backend: at least one pending candidate, scored in the review band.
    const braid = await makeBraidApi(request, context);
    const candidates = await braid.get<BraidCandidateRow[]>('/candidates', {
      'filter[status]': 'pending',
    });
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const candidate = candidates.find((c) => c.score >= 0.8 && c.score < 0.9);
    expect(candidate, 'seeded ~86% pending candidate should be returned').toBeTruthy();

    await page.goto('/braid/review-queue');
    await expect(page.getByRole('heading', { name: 'Merge review queue' })).toBeVisible();

    // Score percentage and both profile-id links render.
    await expect(page.getByText('86%')).toBeVisible();
    await expect(page.getByRole('button', { name: candidate!.profile_a_id })).toBeVisible();
    await expect(page.getByRole('button', { name: candidate!.profile_b_id })).toBeVisible();

    // Decision controls.
    const evidenceBtn = page.getByRole('button', { name: /Evidence/ });
    await expect(evidenceBtn).toBeVisible();
    await expect(page.getByRole('button', { name: 'Confirm' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reject' })).toBeVisible();

    // Expanding Evidence reveals the reproducible feature breakdown.
    await evidenceBtn.click();
    await expect(page.getByText(/braid-resolver-v1/)).toBeVisible();
    await expect(page.getByText('name_phonetic')).toBeVisible();
  });

  // Story 4: Settings. The thresholds and enabled-source-type controls render,
  // reflecting the seeded gilligan config; GET /settings returns 200.
  test('renders settings thresholds and enabled source types', async ({
    page,
    request,
    context,
  }) => {
    await page.goto('/braid/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    // Threshold controls render with the seeded values (auto-merge 0.92, review 0.6).
    await expect(page.getByRole('heading', { name: 'Decision thresholds' })).toBeVisible();
    await expect(page.locator('label:has-text("Auto-merge threshold") + input')).toHaveValue('0.92');
    await expect(page.locator('label:has-text("Review threshold") + input')).toHaveValue('0.6');

    // Enabled-source-type controls: book.event_attendee is enabled, helpdesk.user is not.
    await expect(page.getByRole('heading', { name: 'Enabled source types' })).toBeVisible();
    await expect(
      page.locator('label:has-text("book.event_attendee") input[type="checkbox"]'),
    ).toBeChecked();
    await expect(
      page.locator('label:has-text("helpdesk.user") input[type="checkbox"]'),
    ).not.toBeChecked();

    // Backend: GET /braid/api/v1/settings → 200 with the seeded thresholds.
    const braid = await makeBraidApi(request, context);
    const settings = await braid.get<{
      auto_merge_threshold: number;
      review_threshold: number;
      enabled_source_types: string[];
    }>('/settings');
    expect(settings.auto_merge_threshold).toBeCloseTo(0.92, 2);
    expect(settings.review_threshold).toBeCloseTo(0.6, 2);
    expect(settings.enabled_source_types).toContain('book.event_attendee');
    expect(settings.enabled_source_types).not.toContain('helpdesk.user');
  });

  // Story 5: Negative / typed-error case. helpdesk.user is a real Braid source
  // type but its visibility branch is not yet verified, so enabling it is
  // rejected with a typed SOURCE_TYPE_NOT_SUPPORTED error. The validation throws
  // before any write, so no settings are mutated (self-cleaning by construction).
  test('rejects enabling an unsupported source type with a typed error', async ({
    request,
    context,
  }) => {
    const braid = await makeBraidApi(request, context);

    let caught: ApiClientError | undefined;
    try {
      await braid.patch('/settings', { enabled_source_types: ['helpdesk.user'] });
    } catch (err) {
      caught = err as ApiClientError;
    }

    expect(caught, 'enabling helpdesk.user should be rejected').toBeInstanceOf(ApiClientError);
    expect(caught!.status).toBe(400);
    expect(caught!.code).toBe('SOURCE_TYPE_NOT_SUPPORTED');

    // Confirm the settings were NOT mutated: helpdesk.user is still absent.
    const settings = await braid.get<{ enabled_source_types: string[] }>('/settings');
    expect(settings.enabled_source_types).not.toContain('helpdesk.user');
  });
});
