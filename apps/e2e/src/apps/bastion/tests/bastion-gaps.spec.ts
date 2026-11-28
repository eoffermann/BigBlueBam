import { test, expect } from '../../../fixtures/base.fixture';
import { DirectApiClient } from '../../../api/api-client';
import { readCsrfTokenFromCookies } from '../../../auth/auth.helper';
import type { APIRequestContext, BrowserContext } from '@playwright/test';
// The ONE source of truth for the seeded rows (spec 10.3).
import { BASTION_SEED_EXPECTATIONS as EXP } from '../../../../../../scripts/seed-gilligan/bastion.expectations.mjs';
import { auditCount, gilliganOrgId, id, outboxEvent, psql, userIdByEmail } from '../bastion-db';

const SKIPPER = process.env.E2E_ADMIN_EMAIL || 'skipper@gilligantravel.example';
// The outbox drainer delivers within seconds; allow for a busy stack.
const DELIVERY = { timeout: 60_000, intervals: [500, 1_000, 2_000] };

// Bastion M6 user stories 4-6 (spec 11.4), against the GILLIGAN seed (scripts/seed-gilligan/
// bastion.mjs, M6 rows):
//   4. The top gap is laptop encryption; "Draft the fix" files a proposal that is decided in the
//      Review queue. Self-cleaning: Skipper REJECTS it, which reopens the gap (the draft and the
//      closed platform mirror stay as history), and the backend is read back: the API, then
//      Postgres (bastion-db.ts, organization-scoped): the draft and gap rows, the agent_proposals
//      mirror, the gap.fix_proposed event's outbox row, the proposal_close outbox row and the
//      mirror decided by Skipper, and the audit rows.
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

// The gap story 4 drafts a fix for, until it has rejected that fix. A failed attempt rejects any
// fix still waiting on it in afterEach, so a retry (and the next run) finds the gap open again
// instead of "a previous run left a fix waiting".
let gapLeftProposed: string | null = null;

test.describe('Bastion - gaps, fixes and accepted risks (M6)', () => {
  test.afterEach(async ({ request, context }) => {
    if (!gapLeftProposed) return;
    const api = await makeApi(request, context);
    const waiting = (await api.getRaw('/fix-drafts', { status: 'proposed', gap_id: gapLeftProposed })).body as { data?: FixDraft[] };
    for (const d of waiting.data ?? []) {
      await api.postRaw(`/fix-drafts/${d.id}/decide`, { decision: 'reject', reason: 'e2e cleanup after a failed attempt' });
    }
    gapLeftProposed = null;
  });

  test('4. Top gap is laptop encryption; Draft the fix files a proposal decided in the Review queue', async ({ page, request, context }) => {
    // The AI rewording (up to 60 s) plus two outbox deliveries do not fit the 60 s default.
    test.setTimeout(180_000);
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
    gapLeftProposed = top!.id;
    await first.getByRole('button', { name: 'Draft the fix' }).click();
    // The draft request awaits the optional AI rewording (up to BASTION_LLM_TIMEOUT_MS, 60 s by
    // default) before the page moves to the Review queue; a 10 s wait raced it.
    await expect(page).toHaveURL(/\/bastion\/review$/, { timeout: 90_000 });

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

    // Postgres read-back, scoped to the GILLIGAN organization.
    const orgId = gilliganOrgId();
    const skipperId = userIdByEmail(SKIPPER);
    const draftId = id(draft.id);
    const [draftStatus, proposalId] = psql(
      `SELECT status || '|' || coalesce(proposal_id::text, '') FROM bastion_fix_drafts WHERE organization_id = '${orgId}' AND id = '${draftId}' AND gap_id = '${id(top!.id)}'`,
    ).split('|');
    expect(draftStatus).toBe('proposed');
    id(proposalId);
    expect(psql(`SELECT status FROM bastion_gaps WHERE organization_id = '${orgId}' AND id = '${id(top!.id)}'`)).toBe('proposed');
    expect(
      psql(
        `SELECT status || '|' || owning_app || '|' || require_human_decider || '|' || proposed_action FROM agent_proposals
          WHERE org_id = '${orgId}' AND id = '${proposalId}' AND subject_type = 'bastion.fix_draft' AND subject_id = '${draftId}'`,
      ),
    ).toBe(`pending|bastion|true|bastion.fix.${EXP.m6.laptop.fixTemplate}`);
    // The gap.fix_proposed Bolt event is an outbox row in the same transaction, and it delivers.
    await expect.poll(() => outboxEvent(orgId, 'gap.fix_proposed', draftId), DELIVERY).toBe(`delivered|gap.fix_proposed|${skipperId}`);
    expect(auditCount(orgId, 'fix.propose', draftId)).toBe(1);

    // Decided in Bastion's Review queue (self-cleaning: reject reopens the gap).
    const card = page.getByTestId('fix-card').filter({ hasText: EXP.m6.laptop.title });
    await card.getByRole('button', { name: 'Reject' }).click();
    await expect(card).toHaveCount(0);
    await expect
      .poll(async () => ((await api.getRaw(`/fix-drafts/${draft.id}`)).body as { data: FixDraft }).data.status)
      .toBe('rejected');
    gapLeftProposed = null;
    const after = ((await api.getRaw('/gaps', { status: 'all', control_id: top!.control_id })).body as { data: Gap[] }).data.find((g) => g.id === top!.id);
    expect(after?.status).toBe('open');

    // Postgres: the draft is rejected by Skipper and the gap is open again.
    expect(psql(`SELECT status || '|' || decided_by FROM bastion_fix_drafts WHERE organization_id = '${orgId}' AND id = '${draftId}'`)).toBe(`rejected|${skipperId}`);
    expect(psql(`SELECT status FROM bastion_gaps WHERE organization_id = '${orgId}' AND id = '${id(top!.id)}'`)).toBe('open');
    // The decision reaches the platform through the proposal_close outbox row, which delivers...
    await expect
      .poll(
        () =>
          psql(
            `SELECT status || '|' || (payload->'request'->>'decision') || '|' || (payload->'request'->>'decided_by') FROM bastion_outbox
              WHERE organization_id = '${orgId}' AND kind = 'proposal_close' AND idempotency_key = 'proposal_close:${proposalId}'`,
          ),
        DELIVERY,
      )
      .toBe(`delivered|rejected|${skipperId}`);
    // ...and the mirror is decided as Skipper by session (the api then publishes proposal.decided).
    expect(
      psql(
        `SELECT status || '|' || decided_by || '|' || decided_auth_method || '|' || (decided_at IS NOT NULL) FROM agent_proposals
          WHERE org_id = '${orgId}' AND id = '${proposalId}'`,
      ),
    ).toBe(`rejected|${skipperId}|session|true`);
    expect(auditCount(orgId, 'fix.reject', draftId)).toBe(1);
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
