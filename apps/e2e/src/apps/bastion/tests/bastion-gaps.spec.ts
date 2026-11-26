import { test, expect } from '../../../fixtures/base.fixture';
import { DirectApiClient } from '../../../api/api-client';
import { readCsrfTokenFromCookies } from '../../../auth/auth.helper';
import type { APIRequestContext, BrowserContext } from '@playwright/test';
// The ONE source of truth for the seeded rows (spec 10.3).
import { BASTION_SEED_EXPECTATIONS as EXP } from '../../../../../../scripts/seed-gilligan/bastion.expectations.mjs';

// Bastion M6 user stories 4-6 (spec 11.4), against the GILLIGAN seed (scripts/seed-gilligan/
// bastion.mjs, M6 rows):
//   4. The top gap is laptop encryption; "Draft the fix" files a proposal that is decided in the
//      Review queue. Self-cleaning: Skipper REJECTS it, which reopens the gap (the draft and the
//      closed platform mirror stay as history), and the backend is read back.
//   5. The code-review control cites PR #42, names the repository on the list that is not
//      connected, shows the ping note; Coral Reef Booking appears as a population gap.
//   6. The Radio Relay control reads "Not met, risk accepted" with owner and expiry, and counts
//      under Not met (one risk accepted).
//
// Auth: the default authenticated context as Skipper (E2E_ADMIN_EMAIL=skipper@gilligantravel.example),
// a cookie session, so the decide route (session-only, spec 2.8) accepts it.

interface Gap {
  id: string;
  control_id: string;
  control_title: string;
  gap_kind: string;
  gap_words: string;
  status: string;
}
interface FixDraft {
  id: string;
  gap_id: string;
  status: string;
  template: string;
  control_title: string;
}

async function makeApi(request: APIRequestContext, context: BrowserContext, base = '/bastion/api/v1'): Promise<DirectApiClient> {
  const csrf = readCsrfTokenFromCookies(await context.cookies()) || undefined;
  return new DirectApiClient(request, base, csrf);
}

async function controlId(api: DirectApiClient, key: string): Promise<string> {
  const res = await api.getRaw('/controls');
  expect(res.status).toBe(200);
  const c = (res.body as { data: Array<{ id: string; control_key: string }> }).data.find((x) => x.control_key === key);
  expect(c, key).toBeDefined();
  return c!.id;
}

test.describe('Bastion - gaps, fixes and accepted risks (M6)', () => {
  test('4. Top gap is laptop encryption; Draft the fix files a proposal decided in the Review queue', async ({ page, request, context }) => {
    const api = await makeApi(request, context);
    const gapsRes = await api.getRaw('/gaps', { limit: '5' });
    expect(gapsRes.status).toBe(200);
    const top = (gapsRes.body as { data: Gap[] }).data[0];
    expect(top?.control_title).toBe(EXP.m6.laptop.title);
    expect(top?.gap_kind).toBe(EXP.m6.laptop.gapKind);
    expect(top?.status, 'a previous run left a fix waiting; decide it in the Review queue first').toBe('open');

    await page.goto('/bastion/gaps');
    const first = page.getByTestId('gap-row').first();
    await expect(first).toContainText(EXP.m6.laptop.title);
    await first.getByRole('button', { name: 'Draft the fix' }).click();
    await expect(page).toHaveURL(/\/bastion\/review$/);

    const drafts = (await api.getRaw('/fix-drafts', { status: 'proposed', gap_id: top!.id })).body as { data: Array<FixDraft & { proposal_id?: string }> };
    expect(drafts.data).toHaveLength(1);
    const draft = drafts.data[0]!;
    expect(draft.template).toBe(EXP.m6.laptop.fixTemplate);
    // The platform mirror is Bastion-owned and needs a human decider (spec 2.4, 2.8).
    const platform = await makeApi(request, context, '/b3/api');
    const mirror = await platform.getRaw('/v1/proposals', { 'filter[status]': 'pending' });
    expect(mirror.status).toBe(200);
    const row = (mirror.body as { data: Array<{ subject_id: string; owning_app: string; require_human_decider: boolean; proposed_action: string }> }).data.find(
      (p) => p.subject_id === draft.id,
    );
    expect(row).toMatchObject({ owning_app: 'bastion', require_human_decider: true, proposed_action: `bastion.fix.${EXP.m6.laptop.fixTemplate}` });

    // Decided in Bastion's Review queue (self-cleaning: reject reopens the gap).
    const card = page.getByTestId('fix-card').filter({ hasText: EXP.m6.laptop.title });
    await card.getByRole('button', { name: 'Reject' }).click();
    await expect(card).toHaveCount(0);
    await expect
      .poll(async () => ((await api.getRaw(`/fix-drafts/${draft.id}`)).body as { data: FixDraft }).data.status)
      .toBe('rejected');
    const after = ((await api.getRaw('/gaps', { status: 'all', control_id: top!.control_id })).body as { data: Gap[] }).data.find((g) => g.id === top!.id);
    expect(after?.status).toBe('open');
  });

  test('5. The code-review control cites PR #42, names the repository not connected, shows the ping note; Coral Reef Booking is a population gap', async ({ page, request, context }) => {
    const api = await makeApi(request, context);
    const cr = EXP.m6.codeReview;
    const id = await controlId(api, cr.controlKey);
    const ev = (await api.getRaw(`/controls/${id}/evidence`, { limit: '5' })).body as {
      data: Array<{ explanation: string | null; cited_labels?: string[] }>;
    };
    const latest = ev.data[0];
    expect(latest?.cited_labels?.some((l) => l.startsWith(`PR #${cr.prNumber} `))).toBe(true);
    expect(latest?.explanation).toContain(cr.pingNote);
    expect(latest?.explanation).toContain('not connected');
    const gaps = ((await api.getRaw('/gaps', { control_id: id })).body as { data: Gap[] }).data;
    expect(gaps.map((g) => g.gap_kind)).toContain('population_drift');

    await page.goto(`/bastion/controls/${id}`);
    await expect(page.getByTestId('cited-chips').first()).toContainText(`PR #${cr.prNumber}`);
    await expect(page.getByTestId('evidence-timeline')).toContainText(cr.pingNote);
    await expect(page.getByTestId('evidence-timeline')).toContainText(cr.listedNotConnected);
    await page.goto('/bastion/gaps');
    await expect(page.getByTestId('gap-list')).toContainText(cr.populationGapWords);
  });

  test('6. The Radio Relay control reads "Not met, risk accepted" with owner and expiry, and counts under Not met', async ({ page, request, context }) => {
    const api = await makeApi(request, context);
    const rr = EXP.m6.radioRelay;
    const id = await controlId(api, rr.controlKey);
    const summary = ((await api.getRaw('/summary')).body as { data: { numbers: { risk_accepted: number; not_met: number }; not_met_label: string } }).data;
    expect(summary.numbers.risk_accepted).toBe(EXP.m6.riskAccepted);
    expect(summary.not_met_label).toContain(`(${EXP.m6.riskAccepted} risk accepted)`);
    const ex = ((await api.getRaw('/exceptions', { control_id: id, status: 'active' })).body as {
      data: Array<{ reason: string; owner_name: string; expires_at: string; small_team_self_approval: boolean }>;
    }).data.find((e) => e.reason === rr.reason);
    expect(ex).toBeDefined();
    expect(ex?.owner_name).toBe(rr.ownerName);
    expect(ex?.small_team_self_approval).toBe(false);

    await page.goto(`/bastion/controls/${id}`);
    await expect(page.getByTestId('control-state-words')).toHaveText(rr.stateWords);
    const risk = page.getByTestId('risk-accepted');
    await expect(risk).toContainText('Risk accepted until');
    await expect(risk).toContainText(`Owner: ${rr.ownerName}`);
    await page.goto('/bastion/');
    await expect(page.getByText(`(${EXP.m6.riskAccepted} risk accepted)`)).toBeVisible();
  });
});
