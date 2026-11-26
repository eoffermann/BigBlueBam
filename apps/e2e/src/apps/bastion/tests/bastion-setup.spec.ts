import { test, expect } from '../../../fixtures/base.fixture';
import { DirectApiClient } from '../../../api/api-client';
import { readCsrfTokenFromCookies } from '../../../auth/auth.helper';
import type { APIRequestContext, BrowserContext } from '@playwright/test';
// The ONE source of truth for the seeded numbers (spec 10.3), typed via
// apps/e2e/src/apps/bastion/bastion-expectations.d.ts.
import { BASTION_SEED_EXPECTATIONS as EXP } from '../../../../../../scripts/seed-gilligan/bastion.expectations.mjs';

// Bastion M3 user story: Skipper set up SOC 2 then ISO 27001 for Gilligan Travel Ltd
// (scripts/seed-gilligan/bastion.mjs). The controls list shows "Not set up yet: 4", the MFA
// control carries both frameworks' references, the ISO Statement of Applicability excludes the
// premises requirements with the island-hut reason, and the GitHub population of two
// repositories is confirmed as the complete list.
//
// Auth: the default authenticated context (.auth/admin.json). Run the setup with
// E2E_ADMIN_EMAIL=skipper@gilligantravel.example so the session carries the bastion.*
// permissions of the gilligan Owner group.
//
// Self-cleaning: read-only except one negative call (confirming an already-confirmed check),
// which the API refuses with 409 and so changes nothing. The backend read-back is the API as the
// same user; a psql read-back filtered by organization_id is not reachable from the Playwright
// runner here (postgres is not exposed to the host), so the seeder's own count check plus these
// API reads stand in for it.

interface ControlRow {
  id: string;
  control_key: string;
  title: string;
  setup_state: string | null;
  requirements: Array<{ ref_code: string; framework_name: string; applicability: string }>;
}
interface ControlList {
  data: ControlRow[];
  counts: { total: number; set_up: number; not_set_up: number; not_applicable: number };
}
interface FrameworkRow {
  id: string;
  template_key: string;
  name: string;
}
interface AssertionRow {
  id: string;
  probe_key: string | null;
  review_status: string;
  population: { kind: string; members: Array<{ value: string; label: string }>; confirmed_at: string | null } | null;
}

async function makeApi(request: APIRequestContext, context: BrowserContext): Promise<DirectApiClient> {
  const csrf = readCsrfTokenFromCookies(await context.cookies()) || undefined;
  return new DirectApiClient(request, '/bastion/api/v1', csrf);
}

async function frameworkIds(api: DirectApiClient): Promise<Record<string, string>> {
  const rows = await api.get<FrameworkRow[]>('/frameworks');
  const out: Record<string, string> = {};
  for (const f of rows) out[f.template_key] = f.id;
  for (const f of EXP.frameworks) expect(out[f.templateKey], `${f.name} is adopted`).toBeTruthy();
  return out;
}

async function controls(api: DirectApiClient, frameworkId?: string): Promise<ControlList> {
  const res = await api.getRaw('/controls', frameworkId ? { framework_id: frameworkId } : undefined);
  expect(res.status).toBe(200);
  return res.body as ControlList;
}

test.describe('Bastion - setup, crosswalk and Not set up yet (M3)', () => {
  test('1. the controls list shows "Not set up yet: 4" and the API agrees', async ({ page, request, context }) => {
    const api = await makeApi(request, context);
    const ids = await frameworkIds(api);
    for (const f of EXP.frameworks) {
      const list = await controls(api, ids[f.templateKey]);
      expect(list.counts.not_set_up, `${f.name} not set up`).toBe(f.notSetUp);
      expect(list.counts.set_up, `${f.name} set up`).toBe(f.setUp);
      expect(list.counts.not_applicable, `${f.name} not applicable`).toBe(f.notApplicable);
    }
    await page.goto('/bastion/controls');
    await expect(page.getByTestId('not-set-up-count')).toContainText(String(EXP.frameworks[0]!.notSetUp));
    await expect(page.getByText(/Not set up yet/).first()).toBeVisible();
  });

  test('2. the MFA control carries both SOC 2 and ISO references', async ({ page, request, context }) => {
    const api = await makeApi(request, context);
    const all = await controls(api);
    const mfa = all.data.find((c) => c.control_key === EXP.mfa.controlKey);
    expect(mfa, 'MFA control').toBeTruthy();
    expect(mfa!.requirements.map((r) => r.ref_code)).toEqual(expect.arrayContaining(EXP.mfa.refs));

    await page.goto('/bastion/controls');
    const row = page.getByRole('row', { name: new RegExp(EXP.mfa.title) }).or(page.locator('li', { hasText: EXP.mfa.title }));
    await expect(row.first()).toBeVisible();
    for (const ref of EXP.mfa.refs) await expect(row.first().getByText(ref, { exact: true })).toBeVisible();
  });

  test('3. ISO excludes the premises control and the SoA lists the exclusions with the reason', async ({ request, context }) => {
    const api = await makeApi(request, context);
    const ids = await frameworkIds(api);
    const iso = await controls(api, ids.iso27001);
    const notApplicable = await api.getRaw('/controls', { framework_id: ids.iso27001!, setup: 'not_applicable' });
    const naKeys = (notApplicable.body as ControlList).data.map((c) => c.control_key);
    expect(naKeys).toEqual([EXP.iso.notApplicableControlKey]);
    expect(iso.data.find((c) => c.control_key === EXP.iso.notApplicableControlKey)?.setup_state).toBe('not_applicable');

    const res = await request.get(`/bastion/api/v1/frameworks/${ids.iso27001}/statement-of-applicability`);
    expect(res.status()).toBe(200);
    expect(res.headers()['content-disposition']).toContain('attachment');
    const lines = (await res.text()).trim().split('\r\n');
    expect(lines.length - 1).toBe(EXP.iso.soaRowCount);
    for (const ref of EXP.iso.notApplicableRefs) {
      const line = lines.find((l) => l.startsWith(`${ref},`));
      expect(line, ref).toBeTruthy();
      expect(line).toContain(',No,');
      expect(line).toContain(EXP.iso.notApplicableReason);
    }
  });

  test('4. setup shows the Compliance project and the confirmed two-repository population', async ({ page, request, context }) => {
    const api = await makeApi(request, context);
    const setup = await api.get<{ compliance_project: { name: string } | null }>('/setup');
    expect(setup.compliance_project?.name).toBe(EXP.complianceProject.name);

    const all = await controls(api);
    for (const key of EXP.githubPopulation.controlKeys) {
      const c = all.data.find((x) => x.control_key === key)!;
      const list = await api.get<AssertionRow[]>(`/controls/${c.id}/assertions`);
      const confirmed = list.find((a) => a.review_status === 'confirmed' && a.population);
      expect(confirmed, `${key} has a confirmed population check`).toBeTruthy();
      expect(confirmed!.population!.confirmed_at).toBeTruthy();
      expect(confirmed!.population!.members.map((m) => m.value).sort()).toEqual([...EXP.githubPopulation.repos].sort());
    }

    await page.goto('/bastion/setup');
    await expect(page.getByText(EXP.complianceProject.name).first()).toBeVisible();
  });

  test('5. a confirmed check cannot be confirmed again (409, nothing changes)', async ({ request, context }) => {
    const api = await makeApi(request, context);
    const all = await controls(api);
    const c = all.data.find((x) => x.control_key === EXP.mfa.controlKey)!;
    const list = await api.get<AssertionRow[]>(`/controls/${c.id}/assertions`);
    const confirmed = list.find((a) => a.review_status === 'confirmed')!;
    expect(confirmed).toBeTruthy();
    const res = await api.postRaw(`/assertions/${confirmed.id}/confirm`, {});
    expect(res.status).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe('ASSERTION_NOT_PROPOSED');
    const after = await controls(api, (await frameworkIds(api)).soc2);
    expect(after.counts.not_set_up).toBe(EXP.frameworks[0]!.notSetUp);
  });
});
