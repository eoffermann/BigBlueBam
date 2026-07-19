import path from 'node:path';
import { test, expect } from '../../../fixtures/base.fixture';
import { DirectApiClient } from '../../../api/api-client';
import { readCsrfTokenFromCookies } from '../../../auth/auth.helper';
import type { APIRequestContext, BrowserContext } from '@playwright/test';

// Bulwark user-story E2E: the AI contract-obligation monitor. Runs against the
// already-seeded gilligan org, where the "Castaway Rescue Subcontract" (scoped to
// the Island Infrastructure project, counterparty Howell) carries three extracted
// obligations, one confirmed+armed notice obligation with four live deadline
// clocks (one per overdue Island task, timezone Pacific/Honolulu), one drafted
// notice awaiting approval, and an expiring "Howell COI" compliance doc.
//
// Auth: the default authenticated context (.auth/admin.json). Run the setup with
// E2E_ADMIN_EMAIL=skipper@gilligantravel.example so the session carries the
// bulwark.* permissions granted to the gilligan Owner group. The negative story
// uses .auth/member.json (E2E_MEMBER_EMAIL=professor@gilligantravel.example), a
// gilligan org member who is NOT a member of the Island Infrastructure project.
//
// Read-only: every story asserts against seeded state; none of them mutate a
// contract, obligation, deadline, or compliance doc, so re-runs stay deterministic.

// Seeded facts (verified against the live DB in the gilligan org).
const CONTRACT_TITLE = 'Castaway Rescue Subcontract';
const CONTRACT_TZ = 'Pacific/Honolulu';
const MEMBER_STATE = path.join(__dirname, '..', '..', '..', '..', '.auth', 'member.json');

interface BulwarkContractRow {
  id: string;
  title: string;
  project_id: string | null;
  timezone: string;
  status: string;
  counterparty_type: string | null;
}
interface BulwarkObligationRow {
  id: string;
  obligation_type: string;
  review_status: string;
  is_armed: boolean;
  title: string;
}
interface BulwarkDeadlineRow {
  id: string;
  status: string;
  notice_status: string;
  resolved_timezone: string;
  due_at: string;
}
interface BulwarkComplianceRow {
  id: string;
  doc_type: string;
  validity_status: string;
  collection_status: string;
  expires_at: string | null;
}

// Build a Bulwark-scoped API client sharing the browser session + CSRF token,
// mirroring how the base fixture builds the b3 client but pointed at /bulwark/api/v1.
async function makeBulwarkApi(
  request: APIRequestContext,
  context: BrowserContext,
): Promise<DirectApiClient> {
  const cookies = await context.cookies();
  const csrf = readCsrfTokenFromCookies(cookies) || undefined;
  return new DirectApiClient(request, '/bulwark/api/v1', csrf);
}

test.describe('Bulwark — AI contract-obligation monitor', () => {
  // Story 1: Obligation ledger. The ledger renders, the seeded contract is listed
  // and auto-selected, and its three clause-cited obligations show with the
  // confirmed+armed notice obligation among them.
  test('lists the seeded contract and its clause-cited obligation ledger', async ({
    page,
    request,
    context,
  }) => {
    await page.goto('/bulwark/');

    // Left rail: the contract picker lists the Castaway Rescue Subcontract.
    await expect(page.getByRole('heading', { name: 'Contracts' })).toBeVisible();
    await expect(page.getByRole('button', { name: new RegExp(CONTRACT_TITLE) })).toBeVisible();

    // The first contract is auto-selected, so the ledger heading (the contract
    // title) and the notice obligation are both on screen.
    await expect(page.getByRole('heading', { name: CONTRACT_TITLE })).toBeVisible();
    await expect(
      page.getByText('Written delay notice to Howell within 10 days'),
    ).toBeVisible();
    // The clause citation and the event binding render on the obligation card.
    await expect(page.getByText(/bound to bam \/ task\.overdue/)).toBeVisible();

    // Backend: GET /contracts → the seeded contract, project-scoped to Island
    // Infrastructure with the Pacific/Honolulu timezone; GET the obligations →
    // exactly the three seeded types, one of them the confirmed+armed notice.
    const bulwark = await makeBulwarkApi(request, context);
    const contracts = await bulwark.get<BulwarkContractRow[]>('/contracts');
    const contract = contracts.find((c) => c.title === CONTRACT_TITLE);
    expect(contract, 'seeded Castaway Rescue Subcontract should be returned').toBeTruthy();
    expect(contract!.timezone).toBe(CONTRACT_TZ);
    expect(contract!.project_id).not.toBeNull();

    const obligations = await bulwark.get<BulwarkObligationRow[]>(
      `/contracts/${contract!.id}/obligations`,
    );
    expect(obligations.length).toBe(3);
    const notice = obligations.find((o) => o.obligation_type === 'notice');
    expect(notice, 'the notice obligation should exist').toBeTruthy();
    expect(notice!.review_status).toBe('confirmed');
    expect(notice!.is_armed).toBe(true);
  });

  // Story 2: Deadline radar. The radar renders and shows at least one armed clock;
  // the backend confirms the notice obligation armed live deadline instances, each
  // resolved in the contract's Pacific/Honolulu timezone.
  test('shows armed deadline clocks on the radar', async ({ page, request, context }) => {
    await page.goto('/bulwark/radar');
    await expect(page.getByRole('heading', { name: 'Deadline radar' })).toBeVisible();

    // At least one deadline row renders (the "contract <8-hex>" deep link is the
    // stable per-row affordance). A "Radar clear" empty state must NOT be shown.
    await expect(page.getByText('Radar clear')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^contract [0-9a-f]{8}$/ }).first()).toBeVisible();

    // Backend: GET /deadlines?filter[status]=open → at least one open deadline,
    // all resolved in the contract timezone.
    const bulwark = await makeBulwarkApi(request, context);
    const deadlines = await bulwark.get<BulwarkDeadlineRow[]>('/deadlines', {
      'filter[status]': 'open',
      limit: 100,
    });
    expect(deadlines.length).toBeGreaterThanOrEqual(1);
    expect(deadlines.every((d) => d.resolved_timezone === CONTRACT_TZ)).toBe(true);
  });

  // Story 3: Notice queue (as a notice.draft holder). The HITL queue shows the
  // drafted notice with its subject and the human decision controls. Nothing is
  // sent unattended.
  test('shows a drafted notice awaiting human approval in the queue', async ({
    page,
    request,
    context,
  }) => {
    await page.goto('/bulwark/notices');
    await expect(page.getByRole('heading', { name: 'Notice review queue' })).toBeVisible();

    // The owner holds bulwark.notice.draft, so the queue is NOT the "Restricted"
    // state and a drafted notice card with the approve/discard controls renders.
    await expect(page.getByText('Restricted')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Approve and send' }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Discard draft' }).first()).toBeVisible();

    // Backend: at least one deadline is in the drafted/approved notice lifecycle,
    // and the drafted one exposes its notice_draft body to a notice.draft holder.
    const bulwark = await makeBulwarkApi(request, context);
    const deadlines = await bulwark.get<BulwarkDeadlineRow[]>('/deadlines', {
      limit: 100,
    });
    const drafted = deadlines.filter(
      (d) => d.notice_status === 'drafted' || d.notice_status === 'approved',
    );
    expect(drafted.length).toBeGreaterThanOrEqual(1);
  });

  // Story 4: Vendor compliance matrix. The matrix renders and the expiring Howell
  // COI is present; the backend confirms the coi doc in the expiring validity state.
  test('shows the expiring Howell COI on the compliance matrix', async ({
    page,
    request,
    context,
  }) => {
    await page.goto('/bulwark/compliance');
    await expect(page.getByRole('heading', { name: 'Vendor compliance' })).toBeVisible();

    // The required doc types are column headers; COI is one of them, and the
    // Howell vendor tier renders a T1 row.
    await expect(page.getByRole('columnheader', { name: 'COI' })).toBeVisible();
    await expect(page.getByText('T1', { exact: true }).first()).toBeVisible();

    // Backend: GET /compliance-docs → the coi doc in the "expiring" validity state.
    const bulwark = await makeBulwarkApi(request, context);
    const docs = await bulwark.get<BulwarkComplianceRow[]>('/compliance-docs');
    const coi = docs.find((d) => d.doc_type === 'coi');
    expect(coi, 'the Howell COI compliance doc should be returned').toBeTruthy();
    expect(coi!.validity_status).toBe('expiring');
    expect(coi!.expires_at).not.toBeNull();
  });

  // Story 5: Settings. The org-tunables page renders and GET /settings returns the
  // org's configuration.
  test('renders the settings page and returns org tunables', async ({
    page,
    request,
    context,
  }) => {
    await page.goto('/bulwark/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

    const bulwark = await makeBulwarkApi(request, context);
    const settings = await bulwark.get<{ default_timezone: string; coi_expiry_lead_days: number }>(
      '/settings',
    );
    expect(typeof settings.default_timezone).toBe('string');
    expect(settings.coi_expiry_lead_days).toBeGreaterThan(0);
  });

  // Story 6: Negative / project-scope gating. The Professor is a gilligan org
  // member but NOT a member of the Island Infrastructure project the contract is
  // scoped to, so both the UI and the API must hide the subcontract entirely
  // (fail closed). Uses the member storage state; no state is mutated.
  test('gates the contract from a non-project-member', async ({ browser }) => {
    const memberContext = await browser.newContext({ storageState: MEMBER_STATE });
    try {
      const memberPage = await memberContext.newPage();
      await memberPage.goto('/bulwark/');
      await expect(memberPage.getByRole('heading', { name: 'Contracts' })).toBeVisible();
      // The Castaway Rescue Subcontract must NOT be listed for the Professor.
      await expect(
        memberPage.getByRole('button', { name: new RegExp(CONTRACT_TITLE) }),
      ).toHaveCount(0);
      await expect(memberPage.getByText('No contracts tracked yet')).toBeVisible();

      // Backend: GET /contracts as the member → empty; the subcontract is hidden.
      // Use the member CONTEXT's own request handle so the call carries the
      // Professor's session cookies (the fixture `request` is the admin's).
      const memberCookies = await memberContext.cookies();
      const memberCsrf = readCsrfTokenFromCookies(memberCookies) || undefined;
      const memberApi = new DirectApiClient(memberContext.request, '/bulwark/api/v1', memberCsrf);
      const contracts = await memberApi.get<BulwarkContractRow[]>('/contracts');
      expect(contracts.find((c) => c.title === CONTRACT_TITLE)).toBeUndefined();
    } finally {
      await memberContext.close();
    }
  });
});
