import { describe, expect, it } from 'vitest';
import { BASTION_CONFIDENCE_WORDS } from '@bigbluebam/shared';
import { bandAnswer, CANNOT_PROVE, type DraftCandidate, notProvenClause, STATE_WORDS } from '../src/library/questionnaire-draft.js';
import { bandWithContext, libraryControlCandidates, type OrgDraftContext } from '../src/services/questionnaire-autofill.service.js';

/**
 * Review batch 37, #389: a drafted questionnaire answer read
 * `"a control this answer relies on" is can't prove yet`. A control cited only through a reused
 * library answer was given a stand-in title, and the status was lower-cased into an ungrammatical
 * clause. The answer must name the real control in the status words the rest of Bastion uses,
 * or leave the clause out, and no exported answer may carry a stand-in label.
 */

const LAPTOPS = '00000000-0000-4000-8000-0000000000a1';
const MFA = '00000000-0000-4000-8000-0000000000a2';
const ref = (id: string) => ({ entity_type: 'bastion.control', entity_id: id });
const key = (id: string) => `bastion.control:${id}`;

const library = (question: string, answer: string, controlId: string): DraftCandidate => ({
  handle: 'L1',
  kind: 'library',
  refs: [ref(controlId)],
  title: question,
  text: '',
  rank: 0.5,
  library: { answer, yes_no: true },
});

function ctx(states: Record<string, DraftCandidate['state']>, titles: Record<string, string>): OrgDraftContext {
  return {
    states: new Map(Object.entries(states)),
    titles: new Map(Object.entries(titles)),
    exceptions: new Map(),
    floors: { high: 0.8, medium: 0.55 },
    maxCalls: 100,
    providerId: null,
  };
}

/** Text a stand-in label or a broken status clause would leave in an exported answer. */
const PLACEHOLDERS = [/a control this answer relies on/i, /"a control"/i, /\bis can't\b/i, /\bis not set up yet\b/i, /""/, /undefined|null|\[object/i];

describe("#389: a drafted answer names the control it can't prove, never a stand-in", () => {
  it('a library answer citing an unprovable control names it by its real title in the app status words', () => {
    const question = 'Are all company laptops encrypted at rest?';
    const cands = [library(question, 'Yes. Every company laptop has full-disk encryption turned on.', LAPTOPS)];
    const c = ctx({ [LAPTOPS]: 'unprovable' }, { [LAPTOPS]: 'Laptops are encrypted' });
    const b = bandWithContext(question, 'yes_no_text', cands, null, new Set([key(LAPTOPS)]), c);
    expect(b.confidence_band).toBe('low');
    expect(b.draft_answer).toBe(`${CANNOT_PROVE} In Bastion, the control "Laptops are encrypted" shows "Can't prove yet".`);
    const reason = b.band_reasons.find((r) => r.code === 'control_not_proven');
    expect(reason?.words).toBe(`${CANNOT_PROVE} The control "Laptops are encrypted" shows "Can't prove yet".`);
  });

  it('the extra control candidates carry the real title from the context', () => {
    const cands = [library('Do you require two-step sign-in?', 'Yes.', MFA)];
    const extra = libraryControlCandidates(cands, ctx({ [MFA]: 'fail' }, { [MFA]: 'Everyone signs in with two steps' }));
    expect(extra).toHaveLength(1);
    expect(extra[0]).toMatchObject({ kind: 'control', title: 'Everyone signs in with two steps', state: 'fail' });
  });

  it('a control whose title is unknown leaves the clause out instead of printing a stand-in', () => {
    const question = 'Do you require two-step sign-in?';
    const cands = [library(question, 'Yes.', MFA)];
    const b = bandWithContext(question, 'yes_no_text', cands, null, new Set([key(MFA)]), ctx({}, {}));
    expect(b.confidence_band).toBe('low');
    expect(b.draft_answer).toBe(CANNOT_PROVE);
  });

  it('notProvenClause uses the exact label the pages show for every not-proven state', () => {
    for (const state of ['fail', 'unprovable', null] as const) {
      const label = STATE_WORDS[state ?? 'not_set_up'] as string;
      expect(notProvenClause('Backups run', state)).toBe(`the control "Backups run" shows "${label}"`);
    }
    expect(notProvenClause('   ', 'fail')).toBe('');
  });

  it('no exported answer carries an unfilled placeholder, whatever the states, titles and band', () => {
    const states: Array<DraftCandidate['state']> = ['pass', 'pass_with_exception', 'fail', 'unprovable', null];
    const titleSets: Array<Record<string, string>> = [{ [LAPTOPS]: 'Laptops are encrypted', [MFA]: 'Everyone signs in with two steps' }, { [LAPTOPS]: 'Laptops are encrypted' }, {}];
    const question = 'Are all company laptops encrypted at rest?';
    let checked = 0;
    for (const a of states) {
      for (const m of states) {
        for (const titles of titleSets) {
          const cands: DraftCandidate[] = [
            library(question, 'Yes. Every company laptop has full-disk encryption turned on.', LAPTOPS),
            { ...library(question, 'Yes. Every staff account uses two-step sign-in.', MFA), handle: 'L2', rank: 0.4 },
          ];
          const c = ctx({ [LAPTOPS]: a, [MFA]: m }, titles);
          c.exceptions.set(LAPTOPS, { reason: 'The old laptop is being replaced', expires_at: '2027-01-01T00:00:00.000Z' });
          const visible = new Set([key(LAPTOPS), key(MFA)]);
          // Without the AI (the reuse path) and with an AI answer citing both library answers.
          for (const response of [null, { answer: 'Yes, laptops are encrypted.', yes_no: true, cites: ['L1', 'L2'], confidence: 0.9, unanswerable: false }]) {
            const b = bandWithContext(question, 'yes_no_text', cands, response, visible, c);
            const exported = `${b.draft_answer ?? ''} ${b.band_reasons.map((r) => r.words).join(' ')}`;
            for (const p of PLACEHOLDERS) expect(exported, `${a}/${m}/${Object.keys(titles).length}`).not.toMatch(p);
            expect(BASTION_CONFIDENCE_WORDS[b.confidence_band]).toBeTruthy();
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBe(150);
  });

  it('a directly retrieved control is named the same way as one cited through the library', () => {
    const control: DraftCandidate = { handle: 'C1', kind: 'control', refs: [ref(LAPTOPS)], title: 'Laptops are encrypted', text: '', rank: 0.5, state: 'fail' };
    const b = bandAnswer({
      question: 'Are laptops encrypted?',
      answer_kind: 'yes_no_text',
      candidates: [control],
      response: { answer: 'Yes.', yes_no: true, cites: ['C1'], confidence: 0.9, unanswerable: false },
      visible: new Set([key(LAPTOPS)]),
      floors: { high: 0.8, medium: 0.55 },
    });
    expect(b.draft_answer).toBe(`${CANNOT_PROVE} In Bastion, the control "Laptops are encrypted" shows "Not met".`);
  });
});
