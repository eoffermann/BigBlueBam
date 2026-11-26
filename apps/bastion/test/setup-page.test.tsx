import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

const impersonation = vi.hoisted(() => ({ value: null as null | { user_id: string } }));
vi.mock('@bigbluebam/ui/impersonation-banner', () => ({
  impersonateHeader: () => ({}),
  getImpersonation: () => impersonation.value,
}));

import { SetupPage } from '@/pages/setup';
import { EMPTY_STEPS, jsonResponse, routedFetch, setupState, wrap } from './helpers';

const POP_CHECK = {
  id: 'a-pop',
  control_id: 'c-peer',
  control_title: 'Code changes are reviewed by a second person',
  kind: 'probe',
  probe_key: 'change.merge_reviewed',
  probe_title: 'Code changes reviewed by a second person',
  plain_statement: 'Every change merged in the listed repositories was approved by a second person.',
  review_status: 'proposed',
  manual_evidence_spec: null,
  population: {
    kind: 'github_repos',
    members: [{ value: 'castaways/rescue-radio-firmware', label: 'castaways/rescue-radio-firmware' }],
    confirmed_at: null,
    confirmed_by: null,
  },
};

const ISO = {
  id: 'f-iso',
  template_key: 'iso27001',
  name: 'ISO 27001',
  status: 'active',
  is_iso: true,
  requirement_count: 93,
  setup: { total: 0, set_up: 0, not_set_up: 0, not_applicable: 0 },
  statement_of_applicability: { complete: false, unmapped_ref_codes: [], undecided_ref_codes: ['A.5.1', 'A.5.2'], decided_count: 1, requirement_count: 3 },
  latest_compile_run: { id: 'r1', status: 'succeeded', assertions_proposed: 1, assertions_dropped: 0 },
};

const REQS = {
  data: [
    { ref_code: 'A.5.1', title: 'Security policies', plain_summary: 'Write them down.', applicability: 'undecided', links: [] },
    { ref_code: 'A.5.2', title: 'Security roles', plain_summary: 'Name the roles.', applicability: 'undecided', links: [] },
    { ref_code: 'A.7.1', title: 'Secure boundaries', plain_summary: 'Walls.', applicability: 'not_applicable', links: [] },
  ],
  framework: { id: 'f-iso', name: 'ISO 27001', is_iso: true },
  statement_of_applicability: ISO.statement_of_applicability,
};

let posts: Array<{ path: string; body: unknown; headers: Record<string, string> }>;

function mount(state = setupState({ proposed_checks: [POP_CHECK], frameworks: [ISO], steps: { ...EMPTY_STEPS, applicability: { done: false, frameworks: [] } } })) {
  posts = [];
  const record = (init: RequestInit, url: URL) => {
    posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: (init.headers ?? {}) as Record<string, string> });
  };
  vi.stubGlobal(
    'fetch',
    routedFetch({
      'GET /bastion/api/v1/setup': () => jsonResponse(200, state),
      'GET /bastion/api/v1/library/templates': () => jsonResponse(200, { data: [] }),
      'GET /bastion/api/v1/frameworks/f-iso/requirements': () => jsonResponse(200, REQS),
      'POST /bastion/api/v1/assertions/a-pop/confirm': (init, url) => {
        record(init, url);
        return jsonResponse(200, { data: { ...POP_CHECK, review_status: 'confirmed' } });
      },
      'POST /b3/api/projects': (init, url) => {
        record(init, url);
        return jsonResponse(201, { data: { id: 'p-new', name: 'Compliance' } });
      },
      'POST /bastion/api/v1/setup/compliance-project': (init, url) => {
        record(init, url);
        return jsonResponse(200, { data: { compliance_project: { id: 'p-new', name: 'Compliance', archived: false } } });
      },
      'POST /bastion/api/v1/frameworks/f-iso/applicability': (init, url) => {
        record(init, url);
        return jsonResponse(200, { data: { links_updated: 2 } });
      },
    }),
  );
  wrap(<SetupPage />);
}

beforeEach(() => {
  impersonation.value = null;
  document.cookie = 'csrf_token=tok123';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Setup wizard', () => {
  it('keeps Confirm off on a population check until "This is the complete list" is ticked', async () => {
    mount();
    const card = await screen.findByTestId('check-a-pop');
    const confirm = within(card).getByRole('button', { name: 'Confirm' });
    expect(within(card).getByText('castaways/rescue-radio-firmware')).toBeInTheDocument();
    expect(confirm).toBeDisabled();
    fireEvent.click(within(card).getByLabelText('This is the complete list'));
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(posts.some((p) => p.path === '/bastion/api/v1/assertions/a-pop/confirm')).toBe(true));
    expect(posts.find((p) => p.path.endsWith('/confirm'))?.body).toEqual({ population_confirmed: true });
  });

  it('disables Confirm and Reject while impersonating, with an explanation', async () => {
    impersonation.value = { user_id: 'someone' };
    mount();
    const card = await screen.findByTestId('check-a-pop');
    fireEvent.click(within(card).getByLabelText('This is the complete list'));
    expect(within(card).getByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(within(card).getByRole('button', { name: 'Reject' })).toBeDisabled();
    expect(screen.getByText(/Only that person can confirm or reject checks/)).toBeInTheDocument();
  });

  it('"Create a Compliance project for me" creates it in Bam, then records it in Bastion', async () => {
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Create a "Compliance" project for me' }));
    await waitFor(() => expect(posts.some((p) => p.path === '/bastion/api/v1/setup/compliance-project')).toBe(true));
    const bam = posts.find((p) => p.path === '/b3/api/projects');
    expect(bam?.body).toMatchObject({ name: 'Compliance', task_id_prefix: 'COMP' });
    expect(bam?.headers['X-CSRF-Token']).toBe('tok123');
    expect(posts.findIndex((p) => p.path === '/b3/api/projects')).toBeLessThan(
      posts.findIndex((p) => p.path === '/bastion/api/v1/setup/compliance-project'),
    );
    expect(posts.find((p) => p.path === '/bastion/api/v1/setup/compliance-project')?.body).toEqual({ project_id: 'p-new' });
  });

  it('"Everything else applies" marks every undecided ISO requirement applicable in one call', async () => {
    mount();
    await waitFor(async () => expect(await screen.findByTestId('soa-progress')).toHaveTextContent('1 of 3 decided'));
    fireEvent.click(screen.getByRole('button', { name: 'Everything else applies' }));
    await waitFor(() => expect(posts.some((p) => p.path.endsWith('/applicability'))).toBe(true));
    expect(posts.find((p) => p.path.endsWith('/applicability'))?.body).toEqual({
      decisions: [
        { ref_code: 'A.5.1', applicability: 'applicable' },
        { ref_code: 'A.5.2', applicability: 'applicable' },
      ],
    });
  });
});
