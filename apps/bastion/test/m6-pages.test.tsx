import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

let impersonating = false;
vi.mock('@bigbluebam/ui/impersonation-banner', () => ({
  impersonateHeader: () => ({}),
  getImpersonation: () => (impersonating ? { user_id: 'u-g', display_name: 'Gilligan' } : null),
}));

import { GapsPage } from '@/pages/gaps';
import { ReviewPage } from '@/pages/review';
import { ControlDetailPage } from '@/pages/control-detail';
import { useAuthStore } from '@/stores/auth.store';
import { ALL_BASTION_PERMISSIONS, VIEWER_PERMISSIONS, jsonResponse, routedFetch, settled, setupState, wrap } from './helpers';

// M6 pages (spec 6.1-6.3): What to fix first, Review queue, Control detail. Plain language, no raw
// ids; floored actions hidden with useCan; deciding disabled while impersonating.

const OWNER = {
  ...ALL_BASTION_PERMISSIONS,
  'bastion.gap.read': true,
  'bastion.gap.dismiss': true,
  'bastion.fix.read': true,
  'bastion.fix.draft': true,
  'bastion.fix.decide': true,
  'bastion.fix.mark_applied': true,
  'bastion.exception.read': true,
  'bastion.exception.propose': true,
  'bastion.exception.approve': true,
  'bastion.drift.read': true,
  'bastion.drift.acknowledge': true,
  'bastion.evaluation.run': true,
};

const CONTROL_ID = '0b0b0b0b-0000-4000-8000-000000000001';
const GAPS = {
  data: [
    {
      id: 'g1',
      control_id: CONTROL_ID,
      control_title: 'Company laptops are encrypted',
      owner_name: 'The Professor',
      assertion_id: 'a1',
      assertion_statement: 'An encryption report covers every laptop',
      gap_kind: 'manual_missing',
      gap_words: 'Evidence not uploaded yet',
      risk_score: 4,
      fix_template: 'evidence_request',
      fix_words: 'Ask for evidence',
      fix_cost: 2,
      status: 'open',
      dismissed_reason: null,
      latest_fix_draft_id: null,
    },
  ],
  stale: null,
  accepted_risks: [
    {
      id: 'e1',
      control_id: CONTROL_ID,
      control_title: 'API keys are rotated',
      scope: 'entity',
      reason: 'The Radio Relay key is rotated by hand each quarter',
      expires_at: '2027-05-01T23:59:59Z',
      owner_name: 'The Professor',
      approved_by_name: 'Skipper',
      small_team_self_approval: false,
      approval_label: null,
    },
  ],
  sort: 'risk',
};

const DRAFT = {
  id: 'd1',
  gap_id: 'g1',
  template: 'evidence_request',
  template_words: 'Ask for evidence',
  title: 'Please upload: Laptop encryption report',
  body_markdown: 'Hi The Professor, Bastion needs a laptop encryption report.',
  payload: {},
  cited_refs: [],
  hidden_citation_count: 0,
  status: 'proposed',
  decided_by_name: null,
  decided_at: null,
  created_by_name: 'Skipper',
  created_by_kind: 'human',
  created_at: '2026-11-26T10:00:00Z',
  gap_kind: 'manual_missing',
  gap_words: 'Evidence not uploaded yet',
  control_id: CONTROL_ID,
  control_title: 'Company laptops are encrypted',
  owner_user_id: 'u-skipper',
  owner_name: 'Skipper',
  proposal_expires_at: '2026-12-10T10:00:00Z',
};

let fetchMock: ReturnType<typeof routedFetch>;

beforeEach(() => {
  impersonating = false;
  useAuthStore.setState({ user: { id: 'u-skipper', org_id: 'o1' } as never, isAuthenticated: true });
  fetchMock = routedFetch({
    'GET /bastion/api/v1/gaps': () => jsonResponse(200, GAPS),
    'GET /bastion/api/v1/summary': () => jsonResponse(200, { data: { frameworks: [] } }),
    'POST /bastion/api/v1/gaps/g1/propose-fix': () => jsonResponse(201, { data: DRAFT }),
    'GET /bastion/api/v1/fix-drafts': (_i, url) => jsonResponse(200, { data: url.searchParams.get('status') === 'proposed' ? [DRAFT] : [] }),
    'POST /bastion/api/v1/fix-drafts/d1/decide': () => jsonResponse(200, { data: { ...DRAFT, status: 'approved' } }),
    'GET /bastion/api/v1/exceptions': () => jsonResponse(200, { data: [] }),
    'GET /bastion/api/v1/setup': () => jsonResponse(200, setupState()),
    'GET /bastion/api/v1/manual-evidence': () => jsonResponse(200, { data: [], counts: {} }),
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('What to fix first', () => {
  it('ranks gaps in plain words, drafts a fix, and lists accepted risks with owner and expiry', async () => {
    const nav = vi.fn();
    const { qc } = wrap(<GapsPage onNavigate={nav} />, OWNER);
    expect(await screen.findByText('Company laptops are encrypted')).toBeInTheDocument();
    expect(screen.getByText(/Evidence not uploaded yet · Owner: The Professor · Fix: Ask for evidence/)).toBeInTheDocument();
    expect(screen.getByTestId('accepted-risks')).toHaveTextContent('Not met, risk accepted until');
    expect(screen.getByTestId('accepted-risks')).toHaveTextContent('Owner: The Professor');
    fireEvent.click(await screen.findByText('Draft the fix'));
    await waitFor(() => expect(nav).toHaveBeenCalledWith('/review'));
    expect(fetchMock.mock.calls.some(([u, i]) => String(u).includes('/gaps/g1/propose-fix') && i?.method === 'POST')).toBe(true);
    await settled(qc);
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('a viewer sees the list but no Draft or Dismiss buttons', async () => {
    wrap(<GapsPage onNavigate={() => {}} />, { ...VIEWER_PERMISSIONS, 'bastion.gap.read': true });
    expect(await screen.findByText('Company laptops are encrypted')).toBeInTheDocument();
    expect(screen.queryByText('Draft the fix')).toBeNull();
    expect(screen.queryByText('Dismiss')).toBeNull();
  });
});

describe('Review queue', () => {
  it('the control owner approves a drafted fix here', async () => {
    const { qc } = wrap(<ReviewPage onNavigate={() => {}} />, OWNER);
    expect(await screen.findByText('Please upload: Laptop encryption report')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Approve'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u, i]) => String(u).includes('/fix-drafts/d1/decide') && JSON.parse(String(i?.body)).decision === 'approve')).toBe(true),
    );
    await settled(qc);
  });

  it('says in plain words how many items behind a draft are hidden, singular and plural (#254)', async () => {
    fetchMock = routedFetch({
      'GET /bastion/api/v1/fix-drafts': (_i, url) =>
        jsonResponse(200, {
          data:
            url.searchParams.get('status') === 'proposed'
              ? [
                  { ...DRAFT, hidden_citation_count: 1 },
                  { ...DRAFT, id: 'd3', title: 'Please upload: Backup report', hidden_citation_count: 3 },
                ]
              : [],
        }),
      'GET /bastion/api/v1/setup': () => jsonResponse(200, setupState()),
      'GET /bastion/api/v1/exceptions': () => jsonResponse(200, { data: [] }),
      'GET /bastion/api/v1/manual-evidence': () => jsonResponse(200, { data: [], counts: {} }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { qc } = wrap(<ReviewPage onNavigate={() => {}} />, OWNER);
    expect(await screen.findByText('Please upload: Backup report')).toBeInTheDocument();
    const notes = screen.getAllByTestId('hidden-citations').map((n) => n.textContent);
    expect(notes).toEqual([
      "1 item behind this result is hidden because you don't have access to it.",
      "3 items behind this result are hidden because you don't have access to them.",
    ]);
    expect(document.body.textContent).not.toMatch(/\(s\)|cited item/);
    await settled(qc);
  });

  it('"Mark as done" takes a pasted Bolt automation link, refusing anything else in plain words (#232)', async () => {
    const RULE = '0b0b0b0b-0000-4000-8000-0000000000b1';
    const rule = { ...DRAFT, id: 'd2', template: 'bolt_rule', template_words: 'Add a Bolt automation', title: 'Turn on the rescue-radio check', status: 'approved', decided_by_name: 'Skipper' };
    fetchMock = routedFetch({
      'GET /bastion/api/v1/fix-drafts': (_i, url) => jsonResponse(200, { data: url.searchParams.get('status') === 'approved' ? [rule] : [] }),
      'POST /bastion/api/v1/fix-drafts/d2/mark-applied': () => jsonResponse(200, { data: { ...rule, status: 'applied' } }),
      'GET /bastion/api/v1/exceptions': () => jsonResponse(200, { data: [] }),
      'GET /bastion/api/v1/setup': () => jsonResponse(200, setupState()),
      'GET /bastion/api/v1/manual-evidence': () => jsonResponse(200, { data: [], counts: {} }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { qc } = wrap(<ReviewPage onNavigate={() => {}} />, OWNER);
    const input = await screen.findByLabelText('Paste the link to the automation you made in Bolt (optional)');
    fireEvent.change(input, { target: { value: 'rule 42' } });
    expect(screen.getByText(/doesn't look like a Bolt automation link/)).toBeInTheDocument();
    expect(screen.getByText('Mark as done')).toBeDisabled();
    fireEvent.change(input, { target: { value: `https://bigbluebam.example/bolt/automations/${RULE}` } });
    expect(screen.queryByText(/doesn't look like a Bolt automation link/)).toBeNull();
    fireEvent.click(screen.getByText('Mark as done'));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => String(u).includes('/fix-drafts/d2/mark-applied') && i?.method === 'POST');
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({ applied_entity_type: 'bolt.rule', applied_entity_id: RULE });
    });
    await settled(qc);
  });

  it('deciding is disabled while impersonating, with the reason', async () => {
    impersonating = true;
    wrap(<ReviewPage onNavigate={() => {}} />, OWNER);
    const approve = await screen.findByText('Approve');
    expect(approve).toBeDisabled();
    expect(screen.getByText(/You are viewing Bastion as another person/)).toBeInTheDocument();
  });
});

describe('Control detail', () => {
  it('reads "Not met, risk accepted" with the owner and expiry', async () => {
    fetchMock = routedFetch({
      [`GET /bastion/api/v1/controls/${CONTROL_ID}`]: () =>
        jsonResponse(200, { data: { id: CONTROL_ID, title: 'API keys are rotated', plain_summary: null, owner_user_id: 'u-p', risk_weight: 4, setup_state: 'set_up', requirements: [{ id: 'l1', framework_id: 'f', ref_code: 'CC6.1', applicability: 'applicable' }], assertions: [] } }),
      'GET /bastion/api/v1/coverage': () =>
        jsonResponse(200, { data: [{ control_id: CONTROL_ID, state_words: 'Not met, risk accepted', reason_words: null, owner_name: 'The Professor', set_up: true }] }),
      [`GET /bastion/api/v1/controls/${CONTROL_ID}/evidence`]: () => jsonResponse(200, { data: [] }),
      'GET /bastion/api/v1/exceptions': () =>
        jsonResponse(200, {
          data: [{ id: 'e1', control_id: CONTROL_ID, status: 'active', scope: 'entity', reason: 'Rotated by hand', owner_name: 'The Professor', decided_by_name: 'Skipper', approval_label: null, expires_at: '2027-05-01T23:59:59Z' }],
        }),
      'GET /bastion/api/v1/fix-drafts': () => jsonResponse(200, { data: [] }),
      'GET /bastion/api/v1/drift': () =>
        jsonResponse(200, { data: [{ id: 'dr1', control_id: CONTROL_ID, from_words: 'Proven', to_words: 'Not met', reason_words: 'the check failed', task_words: 'Task created', bam_task_human_id: 'COMP-3', acknowledged_at: null, detected_at: '2026-11-20T03:00:00Z' }] }),
      'GET /bastion/api/v1/gaps': () => jsonResponse(200, { data: [], stale: null, accepted_risks: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    wrap(<ControlDetailPage controlId={CONTROL_ID} onNavigate={() => {}} />, OWNER);
    expect(await screen.findByTestId('control-state-words')).toHaveTextContent('Not met, risk accepted');
    expect(await screen.findByTestId('risk-accepted')).toHaveTextContent(/Risk accepted until .*Owner: The Professor/);
    expect(await screen.findByText('COMP-3')).toBeInTheDocument();
    expect(screen.getByText('Accept this as a risk')).toBeInTheDocument();
    expect(screen.getByText('Check now')).toBeInTheDocument();
  });
});
