import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

let impersonating = false;
vi.mock('@bigbluebam/ui/impersonation-banner', () => ({
  impersonateHeader: () => ({}),
  getImpersonation: () => (impersonating ? { user_id: 'u-g', display_name: 'Gilligan' } : null),
}));

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BASTION_CONFIDENCE_WORDS } from '@bigbluebam/shared';
import { QuestionnaireDetailPage, QuestionnairesPage, bandCountsWords, draftingEstimate } from '@/pages/questionnaires';
import { ALL_BASTION_PERMISSIONS, MEMBER_PERMISSIONS, jsonResponse, routedFetch, settled, wrap } from './helpers';

// M8 page (spec 6.1-6.3): Questionnaires. Plain words ("Sure", "Check this", "Needs an expert"),
// citations as named chips, no raw ids; Approve hidden from people who may not approve, disabled
// (with the reason) until the "Needs an expert" rows are reviewed, and disabled while impersonating.

const Q = '0e0e0e0e-0000-4000-8000-000000000001';
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const OWNER = {
  ...ALL_BASTION_PERMISSIONS,
  'bastion.questionnaire.read': true,
  'bastion.questionnaire.write': true,
  'bastion.questionnaire.approve': true,
  'bastion.questionnaire.export': true,
  'bastion.answer_library.read': true,
  'bastion.answer_library.write': true,
};
const MEMBER = { ...MEMBER_PERMISSIONS, 'bastion.questionnaire.read': true, 'bastion.questionnaire.write': true, 'bastion.questionnaire.export': true, 'bastion.answer_library.read': true };

const QUESTIONNAIRE = {
  id: Q,
  title: 'Howell Industries Vendor Security Review',
  requester_label: 'Howell Industries',
  format: 'xlsx',
  status: 'in_review',
  injection_suspected: false,
  row_count: 3,
  rows_done: 3,
  high_count: 1,
  medium_count: 1,
  low_count: 1,
  due_date: null,
  owner_name: 'Skipper',
  approved_by_name: null,
  approved_at: null,
  drafting_now: false,
  created_at: '2026-11-26T00:00:00Z',
  column_map: { sheets: [], guessed: true },
  source_truncated: false,
  counts_label: null,
};

const item = (n: number, over: Record<string, unknown>) => ({
  id: `0f0f0f0f-0000-4000-8000-00000000000${n}`,
  sheet_name: 'Security',
  row_index: n,
  section: null,
  answer_kind: 'yes_no_text',
  draft_yes_no: null,
  final_answer: null,
  final_yes_no: null,
  cited_refs: [],
  hidden_citation_count: 0,
  band_reasons: [],
  review_status: 'pending',
  assigned_to_name: null,
  reviewed_by_name: null,
  needs_review: false,
  ...over,
});

const ITEMS = [
  item(1, {
    question_text: 'Do you require two-step sign-in for every account?',
    draft_answer: 'Yes, every account uses two-step sign-in.',
    draft_yes_no: true,
    confidence_band: 'high',
    confidence_words: 'Sure',
    cited_refs: [{ entity_type: 'bastion.control', entity_id: '0a0a0a0a-0000-4000-8000-000000000001', label: 'Two-step sign-in for every account', state_words: 'Proven' }],
  }),
  item(2, {
    question_text: 'Are all company laptops encrypted?',
    draft_answer: 'We cannot currently prove this. In Bastion, "Laptop disk encryption" is not met.',
    confidence_band: 'low',
    confidence_words: 'Needs an expert',
    band_reasons: [{ code: 'control_not_proven', words: 'We cannot currently prove this. "Laptop disk encryption" is not met.' }],
    needs_review: true,
  }),
  item(3, {
    question_text: 'Do you rotate service keys every year?',
    draft_answer: 'Yes, keys rotate yearly. (Accepted exception: the Radio Relay key cannot rotate until firmware 2.0 until 2027-03-01.)',
    draft_yes_no: true,
    confidence_band: 'medium',
    confidence_words: 'Check this',
    band_reasons: [{ code: 'accepted_exception', words: 'This relies on a control that passes only with an accepted exception.' }],
  }),
];

function api(approval: Record<string, unknown>, patches: unknown[] = []) {
  return routedFetch({
    [`GET /bastion/api/v1/questionnaires/${Q}`]: () => jsonResponse(200, { data: QUESTIONNAIRE }),
    [`GET /bastion/api/v1/questionnaires/${Q}/items`]: () => jsonResponse(200, { data: ITEMS, approval }),
    'PATCH /bastion/api/v1/questionnaire-items/0f0f0f0f-0000-4000-8000-000000000002': (init) => {
      patches.push(JSON.parse(String(init.body)));
      return jsonResponse(200, { data: ITEMS[1], approval });
    },
  });
}

const BLOCKED = { low_unreviewed: 1, waiting_on_owner: 0, undrafted: 0, medium_unreviewed: 1, can_approve: false, blocked_because: ['1 "Needs an expert" answer still to review'] };
const READY = { ...BLOCKED, low_unreviewed: 0, can_approve: true, blocked_because: [] };

beforeEach(() => {
  impersonating = false;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Questionnaires (M8)', () => {
  it('shows confidence words, named citation chips and exception notes, and no raw ids', async () => {
    vi.stubGlobal('fetch', api(BLOCKED));
    const view = wrap(<QuestionnaireDetailPage questionnaireId={Q} onNavigate={() => {}} />, OWNER);
    await screen.findByText('Do you require two-step sign-in for every account?');
    expect(screen.getAllByTestId('band').map((b) => b.textContent)).toEqual(['Sure', 'Needs an expert', 'Check this']);
    expect(screen.getByText(/We cannot currently prove this\. In Bastion/)).toBeTruthy();
    expect(screen.getByText(/Accepted exception: the Radio Relay key/)).toBeTruthy();
    expect(screen.getByTestId('citation').textContent).toBe('Two-step sign-in for every account (Proven)');
    expect(UUID_RE.test(document.body.textContent ?? '')).toBe(false);
    await settled(view.qc);
  });

  it('Approve is disabled, with the reason, until the "Needs an expert" rows are reviewed', async () => {
    vi.stubGlobal('fetch', api(BLOCKED));
    const view = wrap(<QuestionnaireDetailPage questionnaireId={Q} onNavigate={() => {}} />, OWNER);
    const approve = (await screen.findByTestId('approve')) as HTMLButtonElement;
    await waitFor(() => expect(screen.getByTestId('approve-blocked').textContent).toMatch(/Needs an expert/));
    expect(approve.disabled).toBe(true);
    await settled(view.qc);
    cleanup();
    vi.stubGlobal('fetch', api(READY));
    const ready = wrap(<QuestionnaireDetailPage questionnaireId={Q} onNavigate={() => {}} />, OWNER);
    await waitFor(() => expect((screen.getByTestId('approve') as HTMLButtonElement).disabled).toBe(false));
    await settled(ready.qc);
  });

  it('Approve is hidden from a member and disabled while impersonating', async () => {
    vi.stubGlobal('fetch', api(READY));
    const member = wrap(<QuestionnaireDetailPage questionnaireId={Q} onNavigate={() => {}} />, MEMBER);
    await screen.findByText('Do you rotate service keys every year?');
    expect(screen.queryByTestId('approve')).toBeNull();
    await settled(member.qc);
    cleanup();
    impersonating = true;
    const owner = wrap(<QuestionnaireDetailPage questionnaireId={Q} onNavigate={() => {}} />, OWNER);
    const approve = (await screen.findByTestId('approve')) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(screen.getByText(/Only that person can approve/)).toBeTruthy();
    await settled(owner.qc);
  });

  it('"Use this answer" accepts the draft', async () => {
    const patches: unknown[] = [];
    vi.stubGlobal('fetch', api(BLOCKED, patches));
    const view = wrap(<QuestionnaireDetailPage questionnaireId={Q} onNavigate={() => {}} />, OWNER);
    await screen.findByText('Are all company laptops encrypted?');
    fireEvent.click(screen.getAllByText('Use this answer')[1] as HTMLElement);
    await waitFor(() => expect(patches).toEqual([{ review_status: 'accepted' }]));
    await settled(view.qc);
  });

  it('lists questionnaires in plain words and shows the add form only to writers', async () => {
    vi.stubGlobal(
      'fetch',
      routedFetch({
        'GET /bastion/api/v1/questionnaires': () => jsonResponse(200, { data: [QUESTIONNAIRE] }),
        'GET /bastion/api/v1/answer-library': () => jsonResponse(200, { data: [] }),
      }),
    );
    const view = wrap(<QuestionnairesPage onNavigate={() => {}} />, OWNER);
    await screen.findByText('Howell Industries Vendor Security Review');
    expect(screen.getByText(/Ready for review · from Howell Industries · 3 questions · 1 Sure, 1 Check this, 1 Needs an expert/)).toBeTruthy();
    expect(screen.getByText('Add a questionnaire')).toBeTruthy();
    await settled(view.qc);
    cleanup();
    const reader = wrap(<QuestionnairesPage onNavigate={() => {}} />, { 'bastion.questionnaire.read': true });
    await screen.findByText('Howell Industries Vendor Security Review');
    expect(screen.queryByText('Add a questionnaire')).toBeNull();
    await settled(reader.qc);
  });

  // #266: every sheet is shown and saved; dropping one needs a confirmation.
  it('maps every sheet: saving one sheet\'s change sends all of them, and leaving one out asks first', async () => {
    const access = { sheet_name: 'Access', header_row: 0, first_row: 1, question_column: 0, answer_column: 1, yes_no_column: null, section_column: null, answer_kind: 'yes_no_text' };
    const devices = { ...access, sheet_name: 'Devices' };
    const MAPPING = {
      ...QUESTIONNAIRE,
      status: 'mapping',
      rows_done: 0,
      column_map: { sheets: [access, devices], guessed: true },
      sheet_preview: [
        { name: 'Access', row_count: 2, column_count: 3, rows: [['Question', 'Answer', 'Notes'], ['Do you use MFA?', '', '']] },
        { name: 'Devices', row_count: 2, column_count: 2, rows: [['Question', 'Answer'], ['Are laptops encrypted?', '']] },
        { name: 'Read me', row_count: 1, column_count: 1, rows: [['Please answer every question.']] },
      ],
    };
    const patches: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      routedFetch({
        [`GET /bastion/api/v1/questionnaires/${Q}`]: () => jsonResponse(200, { data: MAPPING }),
        [`PATCH /bastion/api/v1/questionnaires/${Q}`]: (init) => {
          patches.push(JSON.parse(String(init.body)));
          return jsonResponse(200, { data: MAPPING });
        },
      }),
    );
    const view = wrap(<QuestionnaireDetailPage questionnaireId={Q} onNavigate={() => {}} />, OWNER);
    await screen.findByText('Do you use MFA?');
    const blocks = screen.getAllByTestId('sheet-mapping');
    expect(blocks.map((b) => b.getAttribute('data-sheet'))).toEqual(['Access', 'Devices', 'Read me']);
    expect(blocks[2]!.textContent).toMatch(/Not used/);
    // Change the first sheet's question column: the save carries every mapped sheet.
    fireEvent.change(blocks[0]!.querySelector('select') as HTMLSelectElement, { target: { value: '2' } });
    fireEvent.click(screen.getByText('Use these columns'));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect((patches[0] as { column_map: { sheets: Array<{ sheet_name: string; question_column: number }> } }).column_map.sheets.map((s) => [s.sheet_name, s.question_column])).toEqual([
      ['Access', 2],
      ['Devices', 0],
    ]);
    expect((patches[0] as Record<string, unknown>).drop_unmapped_sheets).toBeUndefined();
    // Leaving a sheet out asks first, then says so to the server.
    fireEvent.click(screen.getAllByText('Do not use this sheet')[1] as HTMLElement);
    fireEvent.click(screen.getByText('Use these columns'));
    expect(screen.getByTestId('confirm-drop').textContent).toMatch(/"Devices" will be left out/);
    fireEvent.click(screen.getByText('Leave them out'));
    await waitFor(() => expect(patches).toHaveLength(2));
    expect(patches[1]).toMatchObject({ drop_unmapped_sheets: true });
    await settled(view.qc);
  });

  // #272: the page, the hooks and the types use @bigbluebam/shared, not hand-copied literals.
  it('takes the confidence words, request bodies and enums from @bigbluebam/shared', () => {
    const page = readFileSync(join(__dirname, '../src/pages/questionnaires.tsx'), 'utf8')
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\/\*\*|\*)/.test(l))
      .join('\n');
    const hooks = readFileSync(join(__dirname, '../src/hooks/use-bastion.ts'), 'utf8');
    const types = readFileSync(join(__dirname, '../src/lib/api.ts'), 'utf8');
    for (const w of ['Sure', 'Check this', 'Needs an expert']) expect(page, w).not.toMatch(new RegExp(`[\\d}] ${w}[,'"]|"${w}"`));
    expect(bandCountsWords({ high_count: 1, medium_count: 2, low_count: 3 })).toBe(
      `1 ${BASTION_CONFIDENCE_WORDS.high}, 2 ${BASTION_CONFIDENCE_WORDS.medium}, 3 ${BASTION_CONFIDENCE_WORDS.low}`,
    );
    expect(hooks).not.toMatch(/review_status: 'accepted' \| 'edited'/);
    expect(hooks).not.toMatch(/source: \{ kind: 'bin_asset'/);
    expect(types).not.toMatch(/status: 'uploaded' \| 'mapping'/);
    expect(types).toMatch(/QuestionnaireSheetMap = BastionQuestionnaireSheetMap/);
  });

  it('estimates drafting time from the spec 7.3 throughput', () => {
    expect(draftingEstimate(96)).toBe('about 16 to 32 minutes');
    expect(draftingEstimate(3)).toBe('about 1 minute');
    expect(draftingEstimate(0)).toBe('a moment');
  });
});
