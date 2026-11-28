import { test, expect } from '../../../fixtures/base.fixture';
import { DirectApiClient } from '../../../api/api-client';
import { readCsrfTokenFromCookies } from '../../../auth/auth.helper';
import type { APIRequestContext, BrowserContext } from '@playwright/test';
// The ONE source of truth for the seeded rows (spec 10.3).
import { BASTION_SEED_EXPECTATIONS as EXP } from '../../../../../../scripts/seed-gilligan/bastion.expectations.mjs';
import { auditCount, gilliganOrgId, id, outboxEvent, psql, userIdByEmail } from '../bastion-db';

// Bastion M8 user story 7 (spec 11.4), against the GILLIGAN seed (scripts/seed-gilligan/
// bastion.mjs, M8 rows): the Howell questionnaire's laptop-encryption row is "Needs an expert"
// ("We cannot currently prove this") and the Radio Relay row is "Check this" naming the accepted
// exception; Approve is disabled until the "Needs an expert" rows are reviewed.
//
// Self-cleaning: the test reviews one low row (Use this answer) and puts it back (Undo review), so
// the questionnaire is left exactly as seeded; it never approves (approving is a person's release
// of answers to a customer, and would change the answer library). The backend is read back: the
// API, then Postgres (bastion-db.ts, organization-scoped): the item row as reviewed by Skipper and
// as put back, one audit row per review, and no questionnaire.approved event or answer-library row.
//
// Auth: the default authenticated context as Skipper, a cookie session.

const M = EXP.m8.questionnaire;
const SKIPPER = process.env.E2E_ADMIN_EMAIL || 'skipper@gilligantravel.example';

interface Item {
  id: string;
  question_text: string;
  confidence_band: string;
  draft_answer: string | null;
  review_status: string;
  band_reasons: Array<{ code: string }>;
}

async function makeApi(request: APIRequestContext, context: BrowserContext): Promise<DirectApiClient> {
  const csrf = readCsrfTokenFromCookies(await context.cookies()) || undefined;
  return new DirectApiClient(request, '/bastion/api/v1', csrf);
}

test.describe('Bastion - questionnaires (M8)', () => {
  test('7. The encryption row is Needs an expert, the Radio Relay row is Check this naming the exception; Approve waits for the low rows', async ({ page, request, context }) => {
    const api = await makeApi(request, context);
    const list = await api.getRaw('/questionnaires');
    expect(list.status).toBe(200);
    const q = (list.body as { data: Array<{ id: string; title: string; status: string; row_count: number; autofill_use_ai: boolean }> }).data.find((x) => x.title === M.title);
    expect(q, 'run the GILLIGAN seed (scripts/seed-gilligan/run-all.mjs) first').toBeDefined();
    const qid = String(q?.id);
    expect(q?.status).toBe('in_review');
    expect(q?.row_count).toBe(M.rows);
    // #271: the seeded state is deterministic: drafted without the AI, the story rows decided by
    // the hard rules on reused approved answers, never by a live model's wording.
    expect(q?.autofill_use_ai).toBe(M.useAi);

    const itemsRes = await api.getRaw(`/questionnaires/${qid}/items`);
    const items = itemsRes.body as { data: Item[]; approval: { can_approve: boolean; low_unreviewed: number } };
    const enc = items.data.find((i) => i.question_text === M.encryption.question) as Item;
    const rr = items.data.find((i) => i.question_text === M.radioRelay.question) as Item;
    expect(enc.confidence_band).toBe(M.encryption.band);
    expect(enc.draft_answer).toMatch(new RegExp(`^${M.encryption.answerStartsWith.replace(/\./g, '\\.')}`));
    expect(rr.confidence_band).toBe(M.radioRelay.band);
    expect(rr.draft_answer).toContain(M.radioRelay.mentions);
    for (const code of M.encryption.reasons) expect(enc.band_reasons.map((r) => r.code)).toContain(code);
    for (const code of M.radioRelay.reasons) expect(rr.band_reasons.map((r) => r.code)).toContain(code);
    expect(items.approval.can_approve).toBe(false);
    expect(items.approval.low_unreviewed).toBeGreaterThan(0);

    await page.goto(`/bastion/questionnaires/${qid}`);
    const encRow = page.getByTestId('questionnaire-item').filter({ hasText: M.encryption.question });
    await expect(encRow.getByTestId('band')).toHaveText(M.encryption.words);
    await expect(encRow.getByTestId('answer')).toContainText(M.encryption.answerStartsWith);
    const rrRow = page.getByTestId('questionnaire-item').filter({ hasText: M.radioRelay.question });
    await expect(rrRow.getByTestId('band')).toHaveText(M.radioRelay.words);
    await expect(rrRow.getByTestId('answer')).toContainText(M.radioRelay.mentions);
    await expect(page.getByTestId('approve')).toBeDisabled();
    await expect(page.getByTestId('approve-blocked')).toContainText('Needs an expert');

    // Postgres, organization-scoped: the seeded row as the API served it.
    const orgId = gilliganOrgId();
    const skipperId = userIdByEmail(SKIPPER);
    const itemId = id(enc.id);
    const itemRow = `FROM bastion_questionnaire_items WHERE organization_id = '${orgId}' AND questionnaire_id = '${id(qid)}' AND id = '${itemId}'`;
    expect(psql(`SELECT review_status || '|' || confidence_band || '|' || (reviewed_by IS NULL) ${itemRow}`)).toBe(`pending|${M.encryption.band}|true`);
    const reviewsBefore = auditCount(orgId, 'questionnaire.item_review', itemId);
    const libraryBefore = psql(`SELECT count(*) FROM bastion_answer_library WHERE organization_id = '${orgId}' AND source_item_id = '${itemId}'`);

    // Review one low row in the UI and read it back; then put it back as seeded.
    await encRow.getByRole('button', { name: 'Use this answer' }).click();
    await expect
      .poll(async () => ((await api.getRaw(`/questionnaires/${qid}/items`)).body as { data: Item[] }).data.find((i) => i.id === enc.id)?.review_status)
      .toBe('accepted');
    // Accepted by Skipper: the drafted answer became the final answer.
    expect(psql(`SELECT review_status || '|' || reviewed_by || '|' || (reviewed_at IS NOT NULL) || '|' || (final_answer IS NOT DISTINCT FROM draft_answer) ${itemRow}`)).toBe(
      `accepted|${skipperId}|true|true`,
    );
    expect(auditCount(orgId, 'questionnaire.item_review', itemId, { key: 'review_status', value: 'accepted' })).toBeGreaterThanOrEqual(1);
    await encRow.getByRole('button', { name: 'Undo review' }).click();
    await expect
      .poll(async () => ((await api.getRaw(`/questionnaires/${qid}/items`)).body as { data: Item[] }).data.find((i) => i.id === enc.id)?.review_status)
      .toBe('pending');
    const after = (await api.getRaw('/questionnaires')).body as { data: Array<{ id: string; status: string }> };
    expect(after.data.find((x) => x.id === qid)?.status).toBe('in_review');

    // Put back exactly as seeded, with both reviews on the audit trail and nothing released.
    expect(psql(`SELECT review_status || '|' || (reviewed_by IS NULL) || '|' || (reviewed_at IS NULL) || '|' || (final_answer IS NULL) ${itemRow}`)).toBe('pending|true|true|true');
    expect(auditCount(orgId, 'questionnaire.item_review', itemId)).toBe(reviewsBefore + 2);
    expect(psql(`SELECT status FROM bastion_questionnaires WHERE organization_id = '${orgId}' AND id = '${id(qid)}'`)).toBe('in_review');
    expect(outboxEvent(orgId, 'questionnaire.approved', qid)).toBe('');
    expect(psql(`SELECT count(*) FROM bastion_answer_library WHERE organization_id = '${orgId}' AND source_item_id = '${itemId}'`)).toBe(libraryBefore);
  });
});
