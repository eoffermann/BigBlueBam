import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

let impersonating = false;
vi.mock('@bigbluebam/ui/impersonation-banner', () => ({
  impersonateHeader: () => ({}),
  getImpersonation: () => (impersonating ? { user_id: 'u-g', display_name: 'Gilligan' } : null),
}));

import { PoliciesPage, beaconArticleFrom, beaconEntryIdFrom } from '@/pages/policies';
import { AttestPage } from '@/pages/attest';
import { useAuthStore } from '@/stores/auth.store';
import { ALL_BASTION_PERMISSIONS, VIEWER_PERMISSIONS, jsonResponse, routedFetch, settled, wrap } from './helpers';

// M7 pages (spec 6.1-6.3): Policies and Policies to read. Plain language, no raw ids; floored
// actions hidden with useCan; acknowledging disabled while impersonating and sending back exactly
// the version and hash that were served.

const POLICY_ID = '0c0c0c0c-0000-4000-8000-000000000001';
const ENTRY_ID = '0d0d0d0d-0000-4000-8000-000000000001';
const HASH = 'ab'.repeat(32);

const OWNER = {
  ...ALL_BASTION_PERMISSIONS,
  'bastion.policy.read': true,
  'bastion.policy.write': true,
  'bastion.attestation.read': true,
  'bastion.attestation.sign': true,
  'bastion.attestation.request': true,
};
const VIEWER = { ...VIEWER_PERMISSIONS, 'bastion.policy.read': true, 'bastion.attestation.read': true, 'bastion.attestation.sign': true };

const POLICY = {
  id: POLICY_ID,
  beacon_entry_id: ENTRY_ID,
  title: 'Island Information Security Policy',
  audience: { kind: 'all' },
  cadence_days: 365,
  owner_user_id: 'u-skipper',
  owner_name: 'Skipper',
  status: 'active',
  beacon_status: 'Active',
  visibility: 'Organization',
  shared_with_everyone: true,
  sharing_problem: null,
  current_version: 1,
  expires_at: '2027-06-01T00:00:00Z',
  days_to_expiry: 187,
  last_verified_at: '2026-11-01T00:00:00Z',
  required_people: 7,
  attested_count: 5,
  not_attested_count: 2,
  attestation_label: '5 of 7 have read the current version',
  created_at: '2026-11-20T00:00:00Z',
  updated_at: '2026-11-20T00:00:00Z',
};

const ATTESTATIONS = {
  policy: POLICY,
  attested: [{ user_id: 'u-skipper', name: 'Skipper', attested_at: '2026-11-21T10:00:00Z' }],
  not_attested: [
    { user_id: 'u-gilligan', name: 'Gilligan', can_open: true },
    { user_id: 'u-ginger', name: 'Ginger', can_open: false },
  ],
  cannot_open_count: 1,
  cannot_open_label: "1 person can't open this policy",
};

const BODY = {
  policy_id: POLICY_ID,
  beacon_entry_id: ENTRY_ID,
  title: 'Island Information Security Policy',
  beacon_version: 3,
  body_markdown: '# Island policy\n\n<b>Coconut radios</b> are company property.',
  body_sha256: HASH,
  saved_at: '2026-11-20T00:00:00Z',
  expires_at: null,
  cadence_days: 365,
  in_audience: true,
  attested_at: null,
  due: true,
};

let fetchMock: ReturnType<typeof routedFetch>;

beforeEach(() => {
  impersonating = false;
  useAuthStore.setState({ user: { id: 'u-gilligan', org_id: 'o1' } as never, isAuthenticated: true });
  fetchMock = routedFetch({
    'GET /bastion/api/v1/policies': () => jsonResponse(200, { data: [POLICY], next_cursor: null }),
    [`GET /bastion/api/v1/policies/${POLICY_ID}/attestations`]: () => jsonResponse(200, { data: ATTESTATIONS }),
    [`POST /bastion/api/v1/policies/${POLICY_ID}/request-attestations`]: () => jsonResponse(200, { data: { due: 2, asked: 2, nudged: 2 } }),
    'GET /bastion/api/v1/me/attestations': () =>
      jsonResponse(200, {
        data: [
          {
            policy_id: POLICY_ID,
            title: 'Island Information Security Policy',
            current_version: 3,
            shared_with_everyone: true,
            due: true,
            state_words: 'Please read and acknowledge',
            last_attested_version: null,
            last_attested_at: null,
            next_due_at: null,
          },
        ],
      }),
    [`GET /bastion/api/v1/policies/${POLICY_ID}/body`]: () => jsonResponse(200, { data: BODY }),
    [`POST /bastion/api/v1/policies/${POLICY_ID}/attest`]: () => jsonResponse(201, { data: { created: true } }),
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Policies', () => {
  it('shows who has read the current version, who cannot open it, and asks people to read it', async () => {
    const { qc } = wrap(<PoliciesPage />, OWNER);
    expect(await screen.findByText('5 of 7 have read the current version')).toBeInTheDocument();
    expect(screen.getByText(/Everyone · Read every 365 days · Owner: Skipper/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('Island Information Security Policy'));
    expect(await screen.findByTestId('cannot-open')).toHaveTextContent("1 person can't open this policy");
    expect(screen.getByTestId('who-has-read')).toHaveTextContent('Ginger (cannot open it)');
    fireEvent.click(screen.getByText('Ask people to read it'));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u, i]) => String(u).includes(`/policies/${POLICY_ID}/request-attestations`) && i?.method === 'POST')).toBe(true),
    );
    await settled(qc);
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('a viewer sees the list but no Link, Ask or Retire buttons', async () => {
    wrap(<PoliciesPage />, VIEWER);
    expect(await screen.findByText('5 of 7 have read the current version')).toBeInTheDocument();
    expect(screen.queryByText('Link a Beacon article')).toBeNull();
    expect(screen.queryByText('Ask people to read it')).toBeNull();
    expect(screen.queryByText('Retire')).toBeNull();
  });

  it('takes a Beacon article link or id', () => {
    expect(beaconEntryIdFrom(`https://example.test/beacon/${ENTRY_ID.toUpperCase()}?x=1`)).toBe(ENTRY_ID);
    expect(beaconEntryIdFrom('not a link')).toBeNull();
    expect(beaconArticleFrom('https://bigbluebam.example/beacon/island-information-security-policy')).toEqual({
      beacon_slug: 'island-information-security-policy',
    });
    expect(beaconArticleFrom(ENTRY_ID)).toEqual({ beacon_entry_id: ENTRY_ID });
    expect(beaconArticleFrom('not a link')).toBeNull();
  });

  it('links an article from the slug link Beacon shows (#239)', async () => {
    const { qc } = wrap(<PoliciesPage />, OWNER);
    fireEvent.click(await screen.findByText('Link a Beacon article'));
    const input = screen.getByPlaceholderText('Open the article in Beacon and copy the address');
    fireEvent.change(input, { target: { value: 'not a link' } });
    expect(screen.getByText(/doesn't look like a Beacon article link/)).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'https://bigbluebam.example/beacon/island-information-security-policy' } });
    expect(screen.queryByText(/doesn't look like a Beacon article link/)).toBeNull();
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => String(u).endsWith('/policies') && i?.method === 'POST');
      expect(call).toBeDefined();
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({ beacon_slug: 'island-information-security-policy', audience: { kind: 'all' } });
    });
    await settled(qc);
  });
});

describe('Policies to read', () => {
  it('shows the served body as text and acknowledges with exactly its version and hash', async () => {
    const { qc } = wrap(<AttestPage />, VIEWER);
    expect(await screen.findByText('Please read and acknowledge')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Read it'));
    const body = await screen.findByTestId('policy-body');
    // Rendered as text: the tag shows literally, nothing is injected.
    expect(body).toHaveTextContent('<b>Coconut radios</b> are company property.');
    expect(body.querySelector('b')).toBeNull();
    fireEvent.click(screen.getByText('I have read and understood this'));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([u, i]) => String(u).includes(`/policies/${POLICY_ID}/attest`) && i?.method === 'POST');
      expect(call).toBeDefined();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({ beacon_version: 3, body_sha256: HASH });
    });
    await settled(qc);
  });

  it('acknowledging is disabled while impersonating, with the reason', async () => {
    impersonating = true;
    wrap(<AttestPage />, VIEWER);
    fireEvent.click(await screen.findByText('Read it'));
    const btn = await screen.findByText('I have read and understood this');
    expect(btn).toBeDisabled();
    expect(screen.getByText(/Only that person can acknowledge this/)).toBeInTheDocument();
  });

  it('without attestation.sign there is no button', async () => {
    wrap(<AttestPage />, { ...VIEWER, 'bastion.attestation.sign': false });
    fireEvent.click(await screen.findByText('Read it'));
    await screen.findByTestId('policy-body');
    expect(screen.queryByText('I have read and understood this')).toBeNull();
  });
});
