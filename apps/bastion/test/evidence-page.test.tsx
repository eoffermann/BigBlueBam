import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, fireEvent } from '@testing-library/react';

vi.mock('@bigbluebam/ui/impersonation-banner', () => ({ impersonateHeader: () => ({}), getImpersonation: () => null }));

import { EvidencePage } from '@/pages/evidence';
import { MEMBER_PERMISSIONS, jsonResponse, routedFetch, wrap } from './helpers';

function item(over: Record<string, unknown>) {
  return {
    kind: 'file',
    description: null,
    source_system: 'Google Workspace',
    owner_name: 'The Professor',
    uploaded_by: 'u-prof',
    uploaded_by_name: 'The Professor',
    produced_on: '2026-11-20',
    period_start: null,
    period_end: null,
    valid_until: '2026-12-08T23:59:59.999Z',
    sensitivity: 'standard',
    blocked_reason: null,
    withdrawn_reason: null,
    personal_data_id: 'pd-1',
    restricted: false,
    masked: false,
    trust_label: 'Uploaded evidence',
    scan_note: null,
    days_left: 12,
    stuck_scan: false,
    links: [],
    created_at: '2026-11-20T10:00:00Z',
    ...over,
  };
}

const LIST = {
  data: [
    item({
      id: 'e1',
      title: 'Two-step sign-in report',
      status: 'active',
      links: [
        {
          assertion_id: 'a1', control_id: 'c1', control_title: 'Two-step sign-in is required', plain_statement: 'x',
          review_verdict: 'pending', reviewed_by: null, reviewed_by_name: null, reviewed_at: null, review_note: null,
          small_team_self_review: false, linked_at: '2026-11-20T10:00:00Z',
        },
      ],
    }),
    item({ id: 'e2', title: 'Laptop list export', status: 'pending_scan', stuck_scan: true, days_left: 40 }),
    item({ id: 'e3', title: 'Crew background checks', kind: 'attestation_statement', trust_label: 'Self-attested', status: 'active', scan_note: 'Not virus-scanned (scanning is off on this installation)' }),
  ],
  counts: { active: 2, pending_scan: 1, stuck: 1, blocked: 0, not_scanned: 1 },
  next_cursor: null,
};

const FEEDS = {
  data: [
    {
      id: 'fd1', feed_key: 'crew-roster', label: 'Crew roster export', source_kind: 'api_push', cadence_days: 1, daily_record_quota: 5000,
      status: 'active', last_record_at: null, records_today: 0, quota_remaining_today: 5000, fresh: false, freshness: 'No records yet', active_keys: 0, record_count: 0,
    },
  ],
};

let fetchMock: ReturnType<typeof routedFetch>;

beforeEach(() => {
  fetchMock = routedFetch({
    'GET /bastion/api/v1/manual-evidence': () => jsonResponse(200, LIST),
    'GET /bastion/api/v1/feeds': () => jsonResponse(200, FEEDS),
    'GET /bastion/api/v1/feeds/fd1/keys': () => jsonResponse(200, { data: [] }),
    'POST /bastion/api/v1/manual-evidence/e2/check-again': () => jsonResponse(200, { data: { ...LIST.data[1], check_result: 'still_pending' } }),
    'POST /bastion/api/v1/feeds/fd1/keys': () =>
      jsonResponse(201, { data: { id: 'k1', feed_id: 'fd1', last4: 'WXYZ', token: 'bbf_0123456789abcdef_SECRETSECRETSECRETWXYZ', push_path: '/x', grace_expires_at: null } }),
    'POST /bastion/api/v1/manual-evidence/e1/links/a1/review': () => jsonResponse(200, { data: LIST.data[0] }),
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const called = (method: string, path: string) =>
  fetchMock.mock.calls.some(([u, init]) => new URL(String(u)).pathname === path && ((init as RequestInit | undefined)?.method ?? 'GET') === method);

describe('EvidencePage', () => {
  it('shows uploads and statements in plain words with "expires in 12 days"', async () => {
    wrap(<EvidencePage />);
    expect(await screen.findByText('Two-step sign-in report')).toBeInTheDocument();
    expect(screen.getAllByText('expires in 12 days').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Waiting for virus scan').length).toBeGreaterThan(0);
    expect(screen.getByText(/Self-attested/)).toBeInTheDocument();
    expect(screen.getByText('Not virus-scanned (scanning is off on this installation)')).toBeInTheDocument();
    expect(screen.getByText('Waiting for review')).toBeInTheDocument();
  });

  it('Check again calls the route for a stuck scan', async () => {
    wrap(<EvidencePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Check again' }));
    await vi.waitFor(() => expect(called('POST', '/bastion/api/v1/manual-evidence/e2/check-again')).toBe(true));
    expect(await screen.findByText('Still waiting for the scan.')).toBeInTheDocument();
  });

  it('Accept reviews a pending link', async () => {
    wrap(<EvidencePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await vi.waitFor(() => expect(called('POST', '/bastion/api/v1/manual-evidence/e1/links/a1/review')).toBe(true));
    const call = fetchMock.mock.calls.find(([u]) => new URL(String(u)).pathname.endsWith('/review'));
    expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ verdict: 'accepted' });
  });

  it('a minted feed key is shown once, with a warning, then dismissed', async () => {
    wrap(<EvidencePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'New key' }));
    const box = await screen.findByTestId('minted-token');
    expect(box).toHaveTextContent('bbf_0123456789abcdef_SECRETSECRETSECRETWXYZ');
    expect(box).toHaveTextContent('It is shown only once');
    fireEvent.click(screen.getByRole('button', { name: 'I have saved it' }));
    expect(screen.queryByTestId('minted-token')).toBeNull();
    expect(document.body.textContent).not.toContain('SECRETSECRET');
  });

  it('hides floored actions from a member (review, withdraw, feed keys)', async () => {
    wrap(<EvidencePage />, MEMBER_PERMISSIONS);
    expect(await screen.findByText('Two-step sign-in report')).toBeInTheDocument();
    await screen.findByText('Crew roster export');
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'New key' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add evidence' })).toBeInTheDocument();
  });
});
