import { describe, expect, it } from 'vitest';
import { LIBRARY_REUSE_MIN_OVERLAP, questionOverlap, type DraftCandidate } from '../src/library/questionnaire-draft.js';
import { bandWithContext, type OrgDraftContext } from '../src/services/questionnaire-autofill.service.js';

/**
 * Review batch 37, #388: in the GILLIGAN Howell review, answers reused from the answer library for
 * two-step sign-in and leaver access cited "Laptops are encrypted". Without the AI, the bander
 * reused whichever library answer ranked above LIBRARY_REUSE_MIN_RANK, and the lexical retrieval is
 * an OR query, so one shared word ("every") put the laptop answer, and its control, on unrelated
 * questions. A reused answer must be one approved for the same question; its citations are then
 * the controls it was approved against.
 */

const LAPTOPS = '00000000-0000-4000-8000-0000000000b1';
const MFA = '00000000-0000-4000-8000-0000000000b2';
const KEYS = '00000000-0000-4000-8000-0000000000b3';
const key = (id: string) => `bastion.control:${id}`;

const LIB_LAPTOPS = { q: 'Are all company laptops encrypted at rest?', a: 'Yes. Every company laptop has full-disk encryption turned on.', control: LAPTOPS };
const LIB_MFA = { q: 'Do you require two-step sign-in for every staff account?', a: 'Yes. Every staff account uses two-step sign-in.', control: MFA };
const LIB_KEYS = { q: 'Do you replace API keys and service credentials at least once a year?', a: 'Yes. API keys and service credentials are replaced at least once a year.', control: KEYS };

/** The library candidates as retrieveCandidates builds them (handle, refs from cited_refs, rank). */
function libraryCandidates(rows: Array<{ q: string; a: string; control: string; rank: number }>): DraftCandidate[] {
  return rows.map((r, i) => ({
    handle: `L${i + 1}`,
    kind: 'library',
    refs: [{ entity_type: 'bastion.control', entity_id: r.control }],
    title: r.q,
    text: '',
    rank: r.rank,
    library: { answer: r.a, yes_no: true },
  }));
}

const ctx: OrgDraftContext = {
  states: new Map<string, DraftCandidate['state']>([
    [LAPTOPS, 'unprovable'],
    [MFA, 'pass'],
    [KEYS, 'pass'],
  ]),
  titles: new Map([
    [LAPTOPS, 'Laptops are encrypted'],
    [MFA, 'Everyone signs in with two steps'],
    [KEYS, 'API keys are replaced and unused ones removed'],
  ]),
  exceptions: new Map(),
  floors: { high: 0.8, medium: 0.55 },
  maxCalls: 100,
  providerId: null,
};
const visible = new Set([key(LAPTOPS), key(MFA), key(KEYS)]);
const draft = (question: string, cands: DraftCandidate[]) => bandWithContext(question, 'yes_no_text', cands, null, visible, ctx);

describe('#388: a reused library answer cites the controls it was approved against, for its own question only', () => {
  it('two library answers with different controls: each question reuses its own answer and cites its own control', () => {
    // The laptop answer ranks FIRST for the two-step question (the live ordering: "every" matched).
    const cands = libraryCandidates([
      { ...LIB_LAPTOPS, rank: 0.35 },
      { ...LIB_MFA, rank: 0.2 },
    ]);
    const mfa = draft(LIB_MFA.q, cands);
    expect(mfa.draft_answer).toBe(LIB_MFA.a);
    expect(mfa.cited_refs).toEqual([{ entity_type: 'bastion.control', entity_id: MFA }]);
    expect(mfa.band_reasons.map((r) => r.code)).toContain('reused_answer');

    const laptops = draft(LIB_LAPTOPS.q, cands);
    expect(laptops.cited_refs).toEqual([{ entity_type: 'bastion.control', entity_id: LAPTOPS }]);
    expect(laptops.draft_answer).toContain('"Laptops are encrypted"');
  });

  it('a question no library answer was approved for reuses nothing, never an unrelated control', () => {
    const cands = libraryCandidates([
      { ...LIB_LAPTOPS, rank: 0.4 },
      { ...LIB_MFA, rank: 0.3 },
      { ...LIB_KEYS, rank: 0.3 },
    ]);
    for (const question of [
      'Is access removed promptly when someone leaves the company?',
      'Is every code change reviewed by a second person before it is merged?',
      'Can every production change be traced to a ticket?',
      'Is customer data encrypted in transit?',
      'Do company laptops lock automatically when left unattended?',
      'Do all staff read and acknowledge your information security policy every year?',
      'Are unused API keys removed?',
    ]) {
      const b = draft(question, cands);
      expect(b.draft_answer, question).toBeNull();
      expect(b.cited_refs, question).toEqual([]);
      expect(b.band_reasons.map((r) => r.code), question).toContain('no_draft');
    }
  });

  it('the overlap rule: the same question in other words still matches, a shared word alone does not', () => {
    expect(questionOverlap(LIB_KEYS.q, LIB_KEYS.q)).toBe(1);
    expect(questionOverlap('Are all of the company laptops encrypted at rest?', LIB_LAPTOPS.q)).toBeGreaterThanOrEqual(LIBRARY_REUSE_MIN_OVERLAP);
    expect(questionOverlap('Do you replace your API key and service credential once a year at least?', LIB_KEYS.q)).toBeGreaterThanOrEqual(LIBRARY_REUSE_MIN_OVERLAP);
    expect(questionOverlap('Do you require two-step sign-in for every staff account?', LIB_LAPTOPS.q)).toBeLessThan(LIBRARY_REUSE_MIN_OVERLAP);
    expect(questionOverlap('', LIB_LAPTOPS.q)).toBe(0);
  });

  it('an AI answer citing a library answer still records that answer’s own controls', () => {
    const cands = libraryCandidates([
      { ...LIB_LAPTOPS, rank: 0.4 },
      { ...LIB_MFA, rank: 0.3 },
    ]);
    const b = bandWithContext(LIB_MFA.q, 'yes_no_text', cands, { answer: 'Yes, every staff account uses two-step sign-in.', yes_no: true, cites: ['L2'], confidence: 0.9, unanswerable: false }, visible, ctx);
    expect(b.cited_refs).toEqual([{ entity_type: 'bastion.control', entity_id: MFA }]);
  });
});
