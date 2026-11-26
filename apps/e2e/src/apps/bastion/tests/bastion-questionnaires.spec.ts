import { test, expect } from '../../../fixtures/base.fixture';
import { DirectApiClient } from '../../../api/api-client';
import { readCsrfTokenFromCookies } from '../../../auth/auth.helper';
import type { APIRequestContext, BrowserContext } from '@playwright/test';
// The ONE source of truth for the seeded rows (spec 10.3).
import { BASTION_SEED_EXPECTATIONS as EXP } from '../../../../../../scripts/seed-gilligan/bastion.expectations.mjs';

// Bastion M8 user story 7 (spec 11.4), against the GILLIGAN seed (scripts/seed-gilligan/
// bastion.mjs, M8 rows): the Howell questionnaire's laptop-encryption row is "Needs an expert"
// ("We cannot currently prove this") and the Radio Relay row is "Check this" naming the accepted
// exception; Approve is disabled until the "Needs an expert" rows are reviewed.
//
// Self-cleaning: the test reviews one low row (Use this answer) and puts it back (Undo review), so
// the questionnaire is left exactly as seeded; it never approves (approving is a person's release
// of answers to a customer, and would change the answer library). The backend is read back.
//
// Auth: the default authenticated context as Skipper, a cookie session.

const M = EXP.m8.questionnaire;

interface Item {
  id: string;
  question_text: string;
  confidence_band: string;
  draft_answer: string | null;
  review_status: string;
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
    const q = (list.body as { data: Array<{ id: string; title: string; status: string; row_count: number }> }).data.find((x) => x.title === M.title);
    expect(q, 'run the GILLIGAN seed (scripts/seed-gilligan/run-all.mjs) first').toBeDefined();
    const qid = String(q?.id);
    expect(q?.status).toBe('in_review');
    expect(q?.row_count).toBe(M.rows);

    const itemsRes = await api.getRaw(`/questionnaires/${qid}/items`);
    const items = itemsRes.body as { data: Item[]; approval: { can_approve: boolean; low_unreviewed: number } };
    const enc = items.data.find((i) => i.question_text === M.encryption.question) as Item;
    const rr = items.data.find((i) => i.question_text === M.radioRelay.question) as Item;
    expect(enc.confidence_band).toBe(M.encryption.band);
    expect(enc.draft_answer).toMatch(new RegExp(`^${M.encryption.answerStartsWith.replace(/\./g, '\\.')}`));
    expect(rr.confidence_band).toBe(M.radioRelay.band);
    expect(rr.draft_answer).toContain(M.radioRelay.mentions);
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

    // Review one low row in the UI and read it back; then put it back as seeded.
    await encRow.getByRole('button', { name: 'Use this answer' }).click();
    await expect
      .poll(async () => ((await api.getRaw(`/questionnaires/${qid}/items`)).body as { data: Item[] }).data.find((i) => i.id === enc.id)?.review_status)
      .toBe('accepted');
    await encRow.getByRole('button', { name: 'Undo review' }).click();
    await expect
      .poll(async () => ((await api.getRaw(`/questionnaires/${qid}/items`)).body as { data: Item[] }).data.find((i) => i.id === enc.id)?.review_status)
      .toBe('pending');
    const after = (await api.getRaw('/questionnaires')).body as { data: Array<{ id: string; status: string }> };
    expect(after.data.find((x) => x.id === qid)?.status).toBe('in_review');
  });
});
