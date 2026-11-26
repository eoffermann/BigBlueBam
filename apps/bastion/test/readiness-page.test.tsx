import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('@bigbluebam/ui/impersonation-banner', () => ({ impersonateHeader: () => ({}), getImpersonation: () => null }));

import { ReadinessPage } from '@/pages/readiness';
import { CoveragePage } from '@/pages/coverage';
import { jsonResponse, routedFetch, wrap } from './helpers';

const NUMBERS = { proven_by_suite: 20, proven_by_evidence: 3, not_met: 6, risk_accepted: 1, cant_prove: 13, not_set_up: 4, checked: 42, total: 46 };

function summary(over: Record<string, unknown> = {}) {
  return {
    data: {
      frameworks: [
        { id: 'f-soc', template_key: 'soc2', name: 'SOC 2', audit_target_date: '2027-03-31' },
        { id: 'f-iso', template_key: 'iso27001', name: 'ISO 27001', audit_target_date: null },
      ],
      selected: null,
      nearest_audit_date: '2027-03-31',
      days_to_audit: 125,
      numbers: NUMBERS,
      headline: '42 of 46 controls checked; 4 not set up yet',
      not_met_label: 'Not met: 6 (1 risk accepted)',
      not_applicable: [],
      banners: [{ code: 'offsite_backup_not_configured', message: 'Evidence files have no off-site backup yet.' }],
      top_gaps: [],
      gaps_ranked: false,
      expiring_evidence: [{ id: 'e1', title: 'Two-step sign-in report', owner_name: 'The Professor', valid_until: '2026-12-08T23:59:59.999Z', days_left: 12 }],
      last_full_run_at: null,
      timezone: 'UTC',
      as_of: '2026-11-26T10:00:00Z',
      ...over,
    },
  };
}

let fetchMock: ReturnType<typeof routedFetch>;

beforeEach(() => {
  fetchMock = routedFetch({
    'GET /bastion/api/v1/summary': (_i, url) =>
      jsonResponse(200, url.searchParams.get('framework_id') === 'f-iso' ? summary({ numbers: { ...NUMBERS, proven_by_suite: 18 }, headline: '41 of 45 controls checked; 4 not set up yet' }) : summary()),
    'GET /bastion/api/v1/coverage': () =>
      jsonResponse(200, {
        data: [
          {
            control_id: 'c1', control_key: 'auth.mfa', title: 'Two-step sign-in is required', category: null, owner_name: null, set_up: true,
            bucket: 'proven_by_evidence', state: 'pass', state_words: 'Proven', reason: null, reason_words: null, risk_accepted: false,
            columns: { native: 0, feed: 0, manual_file: 1, self_attested: 0 }, coverage_kind: 'manual_file', manual_expires_at: null, manual_days_left: 12, last_evaluated_at: null,
          },
          {
            control_id: 'c2', control_key: 'hr.screening', title: 'People are checked before they join', category: null, owner_name: null, set_up: true,
            bucket: 'cant_prove', state: 'unprovable', state_words: "Can't prove yet", reason: 'manual_evidence_missing', reason_words: 'Waiting for someone to upload the evidence this needs.',
            risk_accepted: false, columns: { native: 0, feed: 0, manual_file: 0, self_attested: 1 }, coverage_kind: 'self_attested', manual_expires_at: null, manual_days_left: null, last_evaluated_at: null,
          },
        ],
        totals: { native: 0, feed: 0, manual_file: 1, self_attested: 1, none: 0 },
        numbers: NUMBERS,
        headline: '42 of 46 controls checked; 4 not set up yet',
        not_applicable: [{ control_id: 'c9', control_key: 'physical.premises', title: 'Offices and equipment rooms are secured' }],
        frameworks: [],
      }),
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ReadinessPage', () => {
  it('shows the four numbers separately, "Not set up yet: 4" and the denominator', async () => {
    wrap(<ReadinessPage />);
    expect(await screen.findByTestId('n-not-set-up')).toHaveTextContent('Not set up yet: 4');
    expect(screen.getByTestId('headline')).toHaveTextContent('42 of 46 controls checked; 4 not set up yet');
    expect(screen.getByTestId('n-suite')).toHaveTextContent('20');
    expect(screen.getByTestId('n-suite')).toHaveTextContent('Proven by the suite');
    expect(screen.getByTestId('n-evidence')).toHaveTextContent('3');
    expect(screen.getByTestId('n-evidence')).toHaveTextContent('Proven by evidence you provided');
    expect(screen.getByTestId('n-not-met')).toHaveTextContent('Not met: 6 (1 risk accepted)');
    expect(screen.getByTestId('n-cant-prove')).toHaveTextContent("Can't prove yet");
    expect(screen.getByText('expires in 12 days')).toBeInTheDocument();
    expect(screen.getByText('Evidence files have no off-site backup yet.')).toBeInTheDocument();
    expect(screen.getByText('The ranked list of what to fix first appears after the nightly check has run.')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('the framework picker asks for that framework and the numbers change', async () => {
    wrap(<ReadinessPage />);
    await screen.findByTestId('n-suite');
    fireEvent.change(screen.getByLabelText('Framework'), { target: { value: 'f-iso' } });
    await vi.waitFor(() => expect(screen.getByTestId('headline')).toHaveTextContent('41 of 45 controls checked'));
    expect(fetchMock.mock.calls.some(([u]) => new URL(String(u)).searchParams.get('framework_id') === 'f-iso')).toBe(true);
    expect(screen.getByTestId('n-suite')).toHaveTextContent('18');
  });
});

describe('CoveragePage', () => {
  it('shows controls by source column, the state words, totals and what does not apply', async () => {
    wrap(<CoveragePage />);
    expect(await screen.findByText('Two-step sign-in is required')).toBeInTheDocument();
    for (const h of ['Checked by the suite', 'Automated feed', 'Uploaded evidence', 'Self-attested']) {
      expect(screen.getByRole('columnheader', { name: h })).toBeInTheDocument();
    }
    expect(screen.getByText('Proven')).toBeInTheDocument();
    expect(screen.getByText('Waiting for someone to upload the evidence this needs.')).toBeInTheDocument();
    expect(screen.getByTestId('coverage-totals')).toHaveTextContent('Not set up yet: 0');
    expect(screen.getByText('Offices and equipment rooms are secured')).toBeInTheDocument();
  });
});
