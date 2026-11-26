import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor, within } from '@testing-library/react';

const impersonation = vi.hoisted(() => ({ value: null as null | { user_id: string } }));
vi.mock('@bigbluebam/ui/impersonation-banner', () => ({
  impersonateHeader: () => ({}),
  getImpersonation: () => impersonation.value,
}));

import { SetupPage } from '@/pages/setup';
import { EMPTY_STEPS, VIEWER_PERMISSIONS, jsonResponse, routedFetch, setupState, wrap } from './helpers';

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

type Routes = Parameters<typeof routedFetch>[0];

function mount(
  state = setupState({ proposed_checks: [POP_CHECK], frameworks: [ISO], steps: { ...EMPTY_STEPS, applicability: { done: false, frameworks: [] } } }),
  opts: { permissions?: Record<string, boolean>; routes?: Routes; templates?: unknown[] } = {},
) {
  posts = [];
  const record = (init: RequestInit, url: URL) => {
    posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: (init.headers ?? {}) as Record<string, string> });
  };
  vi.stubGlobal(
    'fetch',
    routedFetch({
      'GET /bastion/api/v1/setup': () => jsonResponse(200, state),
      'GET /bastion/api/v1/library/templates': () => jsonResponse(200, { data: opts.templates ?? [] }),
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
      ...(opts.routes ?? {}),
    }),
  );
  wrap(<SetupPage />, opts.permissions);
}

/** Record a request the way the built-in routes do (for routes a test adds). */
function recorded(respond: () => Response) {
  return (init: RequestInit, url: URL) => {
    posts.push({ path: url.pathname, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: (init.headers ?? {}) as Record<string, string> });
    return respond();
  };
}

beforeEach(() => {
  impersonation.value = null;
  document.cookie = 'csrf_token=tok123';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Setup wizard: the AI's not-applicable suggestions (#238, #254)", () => {
  const SUGGESTIONS = {
    data: [
      {
        ref_code: 'A.5.2',
        title: 'Security roles',
        suggested_reason: 'Everyone on the island shares one role.',
        controls: [{ control_key: 'governance.roles', control_title: 'Security roles are assigned', reason: 'Everyone on the island shares one role.' }],
      },
    ],
    compile_run_id: '0b0b0b0b-0000-4000-8000-000000000001',
  };

  it('shows each suggestion with its reason, and "Does not apply" saves the (editable) reason', async () => {
    mount(undefined, { routes: { 'GET /bastion/api/v1/frameworks/f-iso/not-applicable-suggestions': () => jsonResponse(200, SUGGESTIONS) } });
    const box = await screen.findByTestId('na-suggestions');
    expect(within(box).getByText(/Bastion's AI suggests this requirement may not apply/)).toBeInTheDocument();
    // #254: no internal component names on a page a non-specialist runs.
    expect(within(box).queryByText(/compiler/i)).toBeNull();
    expect(within(box).getByText('Security roles are assigned: Everyone on the island shares one role.')).toBeInTheDocument();
    const reason = within(box).getByLabelText('Why A.5.2 does not apply') as HTMLInputElement;
    expect(reason.value).toBe('Everyone on the island shares one role.');
    fireEvent.change(reason, { target: { value: 'Everyone on the island shares one role; the Skipper decides.' } });
    fireEvent.click(within(box).getByRole('button', { name: 'Does not apply' }));
    await waitFor(() => expect(posts.some((p) => p.path === '/bastion/api/v1/frameworks/f-iso/applicability')).toBe(true));
    expect(posts.find((p) => p.path.endsWith('/applicability'))?.body).toEqual({
      decisions: [{ ref_code: 'A.5.2', applicability: 'not_applicable', not_applicable_reason: 'Everyone on the island shares one role; the Skipper decides.' }],
    });
  });

  it('"It applies" keeps the requirement in scope', async () => {
    mount(undefined, { routes: { 'GET /bastion/api/v1/frameworks/f-iso/not-applicable-suggestions': () => jsonResponse(200, SUGGESTIONS) } });
    const box = await screen.findByTestId('na-suggestions');
    fireEvent.click(within(box).getByRole('button', { name: 'It applies' }));
    await waitFor(() =>
      expect(posts.find((p) => p.path.endsWith('/applicability'))?.body).toEqual({ decisions: [{ ref_code: 'A.5.2', applicability: 'applicable' }] }),
    );
  });

  it('shows nothing when there are no suggestions', async () => {
    mount(undefined, { routes: { 'GET /bastion/api/v1/frameworks/f-iso/not-applicable-suggestions': () => jsonResponse(200, { data: [], compile_run_id: null }) } });
    await screen.findByTestId('check-a-pop');
    expect(screen.queryByTestId('na-suggestions')).toBeNull();
  });
});

describe('Setup wizard', () => {
  it('keeps Confirm off on a population check until "This is the complete list" is ticked', async () => {
    mount();
    const card = await screen.findByTestId('check-a-pop');
    const confirm = await within(card).findByRole('button', { name: 'Confirm' });
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
    expect(await within(card).findByRole('button', { name: 'Confirm' })).toBeDisabled();
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

const SOC2_TEMPLATE = {
  template_key: 'soc2',
  name: 'SOC 2',
  description: 'Trust services criteria.',
  is_iso: false,
  requirement_count: 33,
  control_count: 46,
  adopted_framework_id: null,
};

describe('Setup wizard permissions (#194)', () => {
  it('an owner sees the write actions', async () => {
    mount(undefined, { templates: [SOC2_TEMPLATE] });
    expect(await screen.findByRole('button', { name: 'Adopt SOC 2' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Save answers' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use an existing project' })).toBeInTheDocument();
  });

  it('a viewer without bastion.framework.write sees no write action and is told who can finish setup', async () => {
    mount(undefined, { templates: [SOC2_TEMPLATE], permissions: VIEWER_PERMISSIONS });
    expect(await screen.findByText('SOC 2')).toBeInTheDocument();
    await screen.findByText('Ask an admin to finish setting up Bastion. You can see where setup stands below.');
    for (const name of [
      'Adopt SOC 2',
      'Save answers',
      'Create a "Compliance" project for me',
      'Use an existing project',
      'Confirm',
      'Reject',
      'Add repository',
      'Everything else applies',
      'Does not apply',
    ]) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect(screen.getByText('An admin of your organization confirms or rejects these checks.')).toBeInTheDocument();
  });

  it('a permission refusal reads as a plain sentence, never a permission id', async () => {
    mount(undefined, {
      routes: {
        'PATCH /bastion/api/v1/setup/profile': () =>
          jsonResponse(403, {
            error: { code: 'PERMISSION_DENIED', message: 'Permission denied: bastion.framework.write', request_id: 'req_1' },
          }),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Save answers' }));
    expect(await screen.findByText('You do not have permission to do this. Ask an admin of your organization.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('bastion.framework.write');
    expect(document.body.textContent).not.toContain('Permission denied');
  });
});

const APP_ID = '7a1b2c3d-0000-4000-8000-00000000a001';
const APP_CHECK = {
  ...POP_CHECK,
  id: 'a-apps',
  control_title: 'Logs are kept long enough',
  probe_key: 'logging.retention_floor',
  plain_statement: 'Every listed app keeps its logs for at least 90 days.',
  population: { kind: 'blip_apps', members: [], confirmed_at: null, confirmed_by: null },
};
const CONNECTED = {
  github_repos: [{ value: 'castaways/rescue-radio-firmware', label: 'castaways/rescue-radio-firmware' }],
  blip_apps: [{ value: APP_ID, label: 'Lagoon Booking Site' }],
};

describe('Population lists (#195)', () => {
  it('an empty app list explains the next step, offers the org\'s apps by name, and keeps Confirm off', async () => {
    mount(setupState({ proposed_checks: [APP_CHECK], connected_populations: CONNECTED }), {
      routes: {
        'POST /bastion/api/v1/assertions/a-apps/revise': recorded(() => jsonResponse(200, { data: APP_CHECK })),
      },
    });
    const card = await screen.findByTestId('check-a-apps');
    expect(within(card).getByTestId('population-empty')).toHaveTextContent(
      'No apps are listed yet. Add the apps Bastion should watch, or reject this check.',
    );
    expect(await within(card).findByRole('button', { name: 'Confirm' })).toBeDisabled();
    expect(within(card).queryByLabelText('This is the complete list')).toBeNull();
    const picker = await within(card).findByLabelText('Add an app');
    expect(within(picker).getByRole('option', { name: 'Lagoon Booking Site' })).toBeInTheDocument();
    fireEvent.change(picker, { target: { value: APP_ID } });
    fireEvent.click(within(card).getByRole('button', { name: 'Add app' }));
    await waitFor(() => expect(posts.some((p) => p.path.endsWith('/a-apps/revise'))).toBe(true));
    expect(posts.find((p) => p.path.endsWith('/a-apps/revise'))?.body).toEqual({ expected_population: [APP_ID] });
  });

  it('with no tracked apps at all, says to add apps in Blip first', async () => {
    mount(setupState({ proposed_checks: [APP_CHECK], connected_populations: { ...CONNECTED, blip_apps: [] } }));
    const card = await screen.findByTestId('check-a-apps');
    expect(within(card).getByTestId('population-empty')).toHaveTextContent('No apps are tracked in Blip yet.');
    expect(within(card).queryByLabelText('Add an app')).toBeNull();
  });

  it('every member can be removed (a revision), and an app is shown by name even if stored with its id', async () => {
    const listed = {
      ...APP_CHECK,
      population: { ...APP_CHECK.population, members: [{ value: APP_ID, label: APP_ID }] },
    };
    mount(setupState({ proposed_checks: [listed, POP_CHECK], connected_populations: CONNECTED }), {
      routes: {
        'POST /bastion/api/v1/assertions/a-apps/revise': recorded(() => jsonResponse(200, { data: APP_CHECK })),
        'POST /bastion/api/v1/assertions/a-pop/revise': recorded(() => jsonResponse(200, { data: POP_CHECK })),
      },
    });
    const apps = await screen.findByTestId('check-a-apps');
    expect(within(apps).getByText('Lagoon Booking Site')).toBeInTheDocument();
    expect(apps.textContent).not.toContain(APP_ID);
    fireEvent.click(await within(apps).findByRole('button', { name: 'Remove Lagoon Booking Site' }));
    const repos = screen.getByTestId('check-a-pop');
    fireEvent.click(within(repos).getByRole('button', { name: 'Remove castaways/rescue-radio-firmware' }));
    await waitFor(() => expect(posts.filter((p) => p.path.endsWith('/revise'))).toHaveLength(2));
    expect(posts.find((p) => p.path.endsWith('/a-apps/revise'))?.body).toEqual({ expected_population: [] });
    expect(posts.find((p) => p.path.endsWith('/a-pop/revise'))?.body).toEqual({ expected_population: [] });
  });
});
