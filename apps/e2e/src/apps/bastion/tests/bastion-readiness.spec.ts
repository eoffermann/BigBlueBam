import { test, expect } from '../../../fixtures/base.fixture';
import { DirectApiClient } from '../../../api/api-client';
import { readCsrfTokenFromCookies } from '../../../auth/auth.helper';
import type { APIRequestContext, BrowserContext } from '@playwright/test';
// The ONE source of truth for the seeded numbers (spec 10.3), typed via
// apps/e2e/src/apps/bastion/bastion-expectations.d.ts.
import { BASTION_SEED_EXPECTATIONS as EXP } from '../../../../../../scripts/seed-gilligan/bastion.expectations.mjs';

// Bastion M5 user stories 1-3 (spec 11.4), against the GILLIGAN seed (scripts/seed-gilligan/
// bastion.mjs, M5 rows):
//   1. Readiness shows the four numbers, "Not set up yet: 4", the denominator, and "Proven by
//      evidence you provided" as its own number.
//   2. The ISO view changes the numbers (the premises control leaves the denominator and is listed
//      as not applying); the Statement of Applicability lists the not-applicable physical
//      requirements.
//   3. The Professor's 2-Step report shows "expires in 12 days" (on the seed day; the assertion
//      reads the expiry back from the API so a later run checks the same sentence).
//
// Auth: the default authenticated context (.auth/admin.json) as Skipper (run the setup with
// E2E_ADMIN_EMAIL=skipper@gilligantravel.example). Read-only: nothing to clean up. The backend
// read-back is the API as the same user (postgres is not reachable from the Playwright runner;
// the seeder's own read-back of the same numbers stands in for psql).

interface Numbers {
  proven_by_suite: number;
  proven_by_evidence: number;
  not_met: number;
  risk_accepted: number;
  cant_prove: number;
  not_set_up: number;
  checked: number;
  total: number;
}
interface Summary {
  numbers: Numbers;
  headline: string;
  not_met_label: string;
  not_applicable: Array<{ control_key: string; title: string }>;
  frameworks: Array<{ id: string; template_key: string; name: string }>;
  expiring_evidence: Array<{ id: string; title: string; days_left: number }>;
}
interface EvidenceItem {
  id: string;
  title: string;
  status: string;
  days_left: number | null;
  trust_label: string;
  links: Array<{ assertion_id: string; review_verdict: string; reviewed_by_name: string | null }>;
}

async function makeApi(request: APIRequestContext, context: BrowserContext): Promise<DirectApiClient> {
  const csrf = readCsrfTokenFromCookies(await context.cookies()) || undefined;
  return new DirectApiClient(request, '/bastion/api/v1', csrf);
}

async function summary(api: DirectApiClient, frameworkId?: string): Promise<Summary> {
  const res = await api.getRaw('/summary', frameworkId ? { framework_id: frameworkId } : undefined);
  expect(res.status).toBe(200);
  return (res.body as { data: Summary }).data;
}

function expiresText(days: number): string {
  if (days === 0) return 'expires today';
  return `expires in ${days} day${days === 1 ? '' : 's'}`;
}

test.describe('Bastion - Readiness and evidence you provided (M5)', () => {
  test('1. Readiness shows the four numbers, Not set up yet: 4, the denominator, and evidence you provided separately', async ({ page, request, context }) => {
    const api = await makeApi(request, context);
    const all = await summary(api);
    expect(all.numbers.not_set_up).toBe(EXP.frameworks[0]!.notSetUp);
    expect(all.numbers.proven_by_evidence).toBe(EXP.m5.provenByEvidence);
    expect(all.headline).toBe(`${all.numbers.checked} of ${all.numbers.total} controls checked; ${all.numbers.not_set_up} not set up yet`);
    // The four numbers plus Not set up yet account for every control in view, never blended.
    const n = all.numbers;
    expect(n.proven_by_suite + n.proven_by_evidence + n.not_met + n.cant_prove + n.not_set_up).toBe(n.total);

    await page.goto('/bastion/');
    await expect(page.getByTestId('headline')).toHaveText(all.headline);
    await expect(page.getByTestId('n-not-set-up')).toContainText(`Not set up yet: ${EXP.frameworks[0]!.notSetUp}`);
    await expect(page.getByTestId('n-suite')).toContainText('Proven by the suite');
    await expect(page.getByTestId('n-suite')).toContainText(String(n.proven_by_suite));
    await expect(page.getByTestId('n-evidence')).toContainText('Proven by evidence you provided');
    await expect(page.getByTestId('n-evidence')).toContainText(String(EXP.m5.provenByEvidence));
    await expect(page.getByTestId('n-not-met')).toContainText(all.not_met_label);
    await expect(page.getByTestId('n-cant-prove')).toContainText("Can't prove yet");
  });

  test('2. the ISO view changes the numbers; the SoA lists the not-applicable physical requirements', async ({ page, request, context }) => {
    const api = await makeApi(request, context);
    const all = await summary(api);
    const iso = all.frameworks.find((f) => f.template_key === 'iso27001');
    const soc = all.frameworks.find((f) => f.template_key === 'soc2');
    expect(iso && soc).toBeTruthy();
    const isoSummary = await summary(api, iso!.id);
    const socSummary = await summary(api, soc!.id);
    const isoExp = EXP.frameworks.find((f) => f.templateKey === 'iso27001')!;
    expect(isoSummary.numbers.total).toBe(isoExp.controlsInView);
    expect(isoSummary.numbers.not_set_up).toBe(isoExp.notSetUp);
    expect(isoSummary.not_applicable.map((c) => c.control_key)).toEqual([EXP.iso.notApplicableControlKey]);
    expect(socSummary.not_applicable).toEqual([]);
    // Picking ISO 27001 drops the premises control out of the "all frameworks" denominator.
    expect(isoSummary.numbers.total).toBeLessThan(all.numbers.total);

    await page.goto('/bastion/');
    await expect(page.getByTestId('headline')).toHaveText(all.headline);
    await page.getByLabel('Framework').selectOption({ label: iso!.name });
    await expect(page.getByTestId('headline')).toHaveText(isoSummary.headline);
    await expect(page.getByText(/does not apply and is left out of these numbers/)).toBeVisible();

    const res = await request.get(`/bastion/api/v1/frameworks/${iso!.id}/statement-of-applicability`);
    expect(res.status()).toBe(200);
    const lines = (await res.text()).trim().split('\r\n');
    for (const ref of EXP.iso.notApplicableRefs) {
      const line = lines.find((l) => l.startsWith(`${ref},`));
      expect(line, ref).toBeTruthy();
      expect(line).toContain(',No,');
      expect(line).toContain(EXP.iso.notApplicableReason);
    }
  });

  test('3. the 2-Step report shows "expires in 12 days"', async ({ page, request, context }) => {
    const api = await makeApi(request, context);
    const list = await api.getRaw('/manual-evidence', { status: 'active' });
    expect(list.status).toBe(200);
    const items = (list.body as { data: EvidenceItem[] }).data;
    const report = items.find((e) => e.title === EXP.m5.twoStep.title);
    expect(report, 'the 2-Step report is in the locker').toBeTruthy();
    expect(report!.trust_label).toBe('Uploaded evidence');
    expect(report!.links.some((l) => l.review_verdict === 'accepted')).toBe(true);
    // Seeded with 12 days left; a run on a later day reads the same item's remaining days.
    expect(report!.days_left).not.toBeNull();
    expect(report!.days_left!).toBeLessThanOrEqual(EXP.m5.twoStep.daysLeft);
    const sentence = expiresText(report!.days_left!);

    await page.goto('/bastion/evidence');
    const row = page.locator('li', { hasText: EXP.m5.twoStep.title }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText(sentence);

    await page.goto('/bastion/');
    await expect(page.locator('li', { hasText: EXP.m5.twoStep.title }).first()).toContainText(sentence);
  });
});
