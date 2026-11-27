import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, render, waitFor } from '@testing-library/react';

let impersonating = false;
vi.mock('@bigbluebam/ui/impersonation-banner', () => ({
  impersonateHeader: () => ({}),
  getImpersonation: () => (impersonating ? { user_id: 'u-g', display_name: 'Gilligan' } : null),
}));

import { SharingPage } from '@/pages/sharing';
import { SettingsPage, changedFields } from '@/pages/settings';
import { AuditorRoomPage, ROOM_GONE, readRoomToken } from '@/pages/room';
import { ALL_BASTION_PERMISSIONS, jsonResponse, routedFetch, settled, wrap } from './helpers';

// M9 pages (spec 5.2, 6.1-6.3): Sharing, Settings and the public auditor room. The room link is
// shown once; disclosure acts are disabled while impersonating; Save sends only what changed; the
// room token travels only as a header, never in a URL.

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const FW = '0c0c0c0c-0000-4000-8000-000000000001';
const ROOM = '0d0d0d0d-0000-4000-8000-000000000001';
const PKT = '0e0e0e0e-0000-4000-8000-000000000009';
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';

const OWNER = {
  ...ALL_BASTION_PERMISSIONS,
  'bastion.auditor_room.read': true,
  'bastion.auditor_room.create': true,
  'bastion.auditor_room.revoke': true,
  'bastion.auditor_room.respond': true,
  'bastion.export.create': true,
  'bastion.export.read': true,
  'bastion.evidence.read_restricted': true,
  'bastion.settings.read': true,
  'bastion.settings.write': true,
  'bastion.ledger.acknowledge_restore': true,
};

const SETUP = {
  data: {
    frameworks: [{ id: FW, template_key: 'iso27001', name: 'ISO 27001', status: 'active', is_iso: true, requirement_count: 93, setup: { total: 1, set_up: 1, not_set_up: 0, not_applicable: 0 }, statement_of_applicability: null }],
    company_profile: {},
    compliance_project: null,
    proposed_checks: [],
    steps: {},
    complete: true,
  },
};

const ROOM_ROW = {
  id: ROOM,
  label: 'Lagoon & Reef CPAs, Type I readiness',
  framework_id: FW,
  framework_name: 'ISO 27001',
  period_start: '2026-09-01',
  period_end: '2026-11-26',
  expires_at: '2026-12-26T00:00:00Z',
  revoked_at: null,
  locked_at: null,
  state: 'active',
  has_passcode: false,
  passcode_failures: 0,
  link_hint: 'abcd...',
  control_count: 40,
  restricted_count: 0,
  access_count: 2,
  last_accessed_at: '2026-11-26T10:00:00Z',
  open_requests: 0,
  created_by_name: 'Skipper',
  created_at: '2026-11-26T09:00:00Z',
};

function sharingApi(over: Record<string, Parameters<typeof routedFetch>[0][string]> = {}) {
  return routedFetch({
    'GET /bastion/api/v1/setup': () => jsonResponse(200, SETUP),
    'GET /bastion/api/v1/manual-evidence': () => jsonResponse(200, { data: [], counts: {}, next_cursor: null }),
    'GET /bastion/api/v1/auditor-rooms': () => jsonResponse(200, { data: [ROOM_ROW] }),
    'GET /bastion/api/v1/auditor-requests': () => jsonResponse(200, { data: [] }),
    'GET /bastion/api/v1/exports': () =>
      jsonResponse(200, {
        data: [
          { id: PKT, framework_id: FW, framework_name: 'ISO 27001', period_start: '2026-09-01', period_end: '2026-11-26', include_restricted: false, status: 'succeeded', stage: null, stage_words: 'Ready to download', size_bytes: 1000, error: null, requested_by_name: 'Skipper', created_at: '2026-11-26T09:00:00Z' },
        ],
      }),
    'POST /bastion/api/v1/auditor-rooms': () => jsonResponse(201, { data: { ...ROOM_ROW, token: TOKEN, link: `/bastion/room#${TOKEN}`, token_notice: 'Copy this link now. It is shown only once.' } }),
    ...over,
  });
}

beforeEach(() => {
  impersonating = false;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = '';
});

describe('Sharing', () => {
  it('creates a room, shows the link once with the "shown only once" text, and sends confirm', async () => {
    const fetchMock = sharingApi();
    vi.stubGlobal('fetch', fetchMock);
    const { qc } = wrap(<SharingPage />, OWNER);
    fireEvent.click(await screen.findByRole('button', { name: /Create auditor room/ }));
    fireEvent.change(screen.getByLabelText('Who is this for?'), { target: { value: 'Lagoon & Reef CPAs' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create room' }));
    expect(await screen.findByText('Copy this link now. It is shown only once.')).toBeInTheDocument();
    expect((screen.getByTestId('room-link') as HTMLInputElement).value).toBe(`${window.location.origin}/bastion/room#${TOKEN}`);
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'POST');
    expect(JSON.parse(String((post?.[1] as RequestInit).body))).toMatchObject({ label: 'Lagoon & Reef CPAs', framework_id: FW, confirm: true, expires_in_days: 30 });
    fireEvent.click(screen.getByRole('button', { name: 'I have copied it' }));
    expect(screen.queryByText('Copy this link now. It is shown only once.')).not.toBeInTheDocument();
    await settled(qc);
  });

  it('disables Create and Revoke while impersonating, with the reason', async () => {
    impersonating = true;
    vi.stubGlobal('fetch', sharingApi());
    const { qc } = wrap(<SharingPage />, OWNER);
    const create = await screen.findByRole('button', { name: /Create auditor room/ });
    await waitFor(() => expect(create).toBeDisabled());
    expect(screen.getAllByText(/Only that person can open, close or unlock an auditor room/).length).toBeGreaterThan(0);
    expect(await screen.findByRole('button', { name: 'Revoke' })).toBeDisabled();
    await settled(qc);
  });

  it('shows Download for a finished packet and no raw ids', async () => {
    vi.stubGlobal('fetch', sharingApi());
    const { qc, container } = wrap(<SharingPage />, OWNER);
    const link = await screen.findByRole('link', { name: /^Download$/ });
    expect(link.getAttribute('href')).toBe(`/bastion/api/v1/exports/${PKT}/download`);
    expect(screen.getByText(/Ready to download/)).toBeInTheDocument();
    await settled(qc);
    expect(container.textContent ?? '').not.toMatch(UUID_RE);
  });
});

const SETTINGS = {
  data: {
    settings: {
      remediation_tasks: 'create',
      timezone: 'UTC',
      evaluation_hour_local: 3,
      llm_provider_id: null,
      stale_after_hours: 36,
      not_assessed_grace_days: 14,
      manual_expiry_warn_days: 30,
      questionnaire_high_floor: 0.8,
      questionnaire_medium_floor: 0.55,
      max_llm_calls_per_compile: 400,
      max_llm_calls_per_questionnaire: 1200,
      max_rows_per_questionnaire: 1000,
      auditor_room_max_days: 90,
      max_packet_bytes: 2147483648,
    },
    compliance_project: { id: 'p', name: 'Compliance' },
    ai_providers: [],
    evidence_integrity: { seal_keys: [{ fingerprint: 'a1b2 c3d4 e5f6', current: true }], personal_data_key: '0011 2233 4455', restores_awaiting: [] },
    offsite_backup: { configured: false, last_backup_at: null, last_mirror_status: 'not_configured', current_through: null },
    storage_ok: true,
    delivery_problems: 1,
  },
};

describe('Settings', () => {
  it('Save sends only the changed fields', async () => {
    const fetchMock = routedFetch({
      'GET /bastion/api/v1/settings': () => jsonResponse(200, SETTINGS),
      'GET /bastion/api/v1/delivery-problems': () => jsonResponse(200, { data: [] }),
      'PATCH /bastion/api/v1/settings': () => jsonResponse(200, SETTINGS),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { qc } = wrap(<SettingsPage />, OWNER);
    fireEvent.change(await screen.findByLabelText('Auditor links last at most (days)'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await screen.findByText('Saved.');
    const patch = fetchMock.mock.calls.find(([, init]) => (init as RequestInit)?.method === 'PATCH');
    expect(JSON.parse(String((patch?.[1] as RequestInit).body))).toEqual({ auditor_room_max_days: 60 });
    expect(screen.getByText(/Evidence copy: Not set up/)).toBeInTheDocument();
    await settled(qc);
  });

  it('changedFields keeps only differences', () => {
    const s = SETTINGS.data.settings as Parameters<typeof changedFields>[0];
    expect(changedFields(s, { ...s, timezone: 'Europe/London' })).toEqual({ timezone: 'Europe/London' });
    expect(changedFields(s, s)).toEqual({});
  });

  it('Try again calls retry and shows its message', async () => {
    const fetchMock = routedFetch({
      'GET /bastion/api/v1/settings': () => jsonResponse(200, SETTINGS),
      'GET /bastion/api/v1/delivery-problems': () =>
        jsonResponse(200, { data: [{ id: 'd1', what: 'An event for Bolt automations', event: 'control.drifted', attempts: 12, retried_before: 0, last_error: 'HTTP 500', created_at: '2026-11-26T00:00:00Z' }] }),
      'POST /bastion/api/v1/delivery-problems/d1/retry': () => jsonResponse(200, { data: { id: 'd1', result: 'retrying', message: 'Bastion will try this delivery again within a minute.' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { qc } = wrap(<SettingsPage />, OWNER);
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Bastion will try this delivery again within a minute.')).toBeInTheDocument();
    await settled(qc);
  });
});

const OVERVIEW = {
  data: {
    room: { label: 'Lagoon & Reef CPAs, Type I readiness', organization_name: 'Gilligan Travel Ltd', framework_name: 'ISO 27001', is_iso: true, period_start: '2026-09-01', period_end: '2026-11-26', expires_at: '2026-12-26T00:00:00Z' },
    numbers: { met: 1, not_met: 0, risk_accepted: 0, cant_prove: 0, not_assessed: 0, total: 1 },
    controls: [{ id: ROOM, control_key: 'auth.mfa', title: 'Everyone signs in with a second step', category: null, owner: 'The Professor', state: 'met', state_words: 'Met', reason: null, requirement_codes: ['A.5.17'], last_evaluated_at: null }],
    accepted_risks: [],
    restricted_items: [],
    statement_of_applicability: [{ ref_code: 'A.7.1', title: 'Physical security perimeters', applicable: 'No', justification: 'Shared island hut', implementing_controls: '', current_status: '' }],
    seals: [],
    public_keys: [],
    notices: [],
    not_an_audit: 'Bastion shows the evidence your organization collected. It is not an auditor and does not certify anything.',
  },
};

describe('Auditor room (public)', () => {
  it('reads the token from the URL fragment and sends it only as a header', async () => {
    window.location.hash = `#${TOKEN}`;
    const fetchMock = routedFetch({ 'GET /bastion/api/v1/public/room': () => jsonResponse(200, OVERVIEW) });
    vi.stubGlobal('fetch', fetchMock);
    render(<AuditorRoomPage />);
    expect(await screen.findByText('Lagoon & Reef CPAs, Type I readiness')).toBeInTheDocument();
    expect(screen.getByText('A.7.1 Physical security perimeters')).toBeInTheDocument();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).not.toContain(TOKEN);
    expect((init as RequestInit).headers).toMatchObject({ 'x-bastion-room-token': TOKEN });
    expect(readRoomToken('#abc')).toBe('abc');
  });

  it('a 404 shows exactly "This link is no longer available."', async () => {
    window.location.hash = `#${TOKEN}`;
    vi.stubGlobal('fetch', routedFetch({ 'GET /bastion/api/v1/public/room': () => jsonResponse(404, { error: { code: 'NOT_FOUND', message: ROOM_GONE } }) }));
    render(<AuditorRoomPage />);
    expect(await screen.findByTestId('room-gone')).toHaveTextContent(ROOM_GONE);
  });

  it('asks for the passcode and sends it as a header', async () => {
    window.location.hash = `#${TOKEN}`;
    const fetchMock = routedFetch({
      'GET /bastion/api/v1/public/room': (init) => {
        const h = (init.headers ?? {}) as Record<string, string>;
        if (h['x-bastion-room-passcode'] === '123456') return jsonResponse(200, OVERVIEW);
        return jsonResponse(401, { error: { code: 'PASSCODE_REQUIRED', message: 'Enter the 6-digit passcode.', details: [{ field: 'passcode', issue: 'attempts_left:5' }] } });
      },
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<AuditorRoomPage />);
    fireEvent.change(await screen.findByLabelText('Enter the 6-digit passcode'), { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Open the room' }));
    expect(await screen.findByText('Lagoon & Reef CPAs, Type I readiness')).toBeInTheDocument();
  });
});
