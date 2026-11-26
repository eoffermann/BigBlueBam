import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@bigbluebam/ui/impersonation-banner', () => ({ impersonateHeader: () => ({}), getImpersonation: () => null }));

import { ControlsPage } from '@/pages/controls';
import { VIEWER_PERMISSIONS, jsonResponse, routedFetch, settled, setupState, wrap } from './helpers';

const CONTROLS = {
  data: [
    { id: 'c1', title: 'Two-step sign-in is required', plain_summary: null, setup_state: 'set_up', requirements: [{ id: 'l1', framework_name: 'SOC 2', ref_code: 'CC6.1', applicability: 'applicable' }, { id: 'l2', framework_name: 'ISO 27001', ref_code: 'A.5.17', applicability: 'applicable' }] },
    { id: 'c2', title: 'We keep up with new threats', plain_summary: null, setup_state: 'not_set_up', requirements: [] },
    { id: 'c3', title: 'Offices and equipment rooms are secured', plain_summary: null, setup_state: 'not_applicable', requirements: [] },
  ],
  counts: { total: 48, set_up: 44, not_set_up: 4, not_applicable: 1 },
  framework_id: null,
};

let fetchMock: ReturnType<typeof routedFetch>;

beforeEach(() => {
  fetchMock = routedFetch({
    'GET /bastion/api/v1/controls': () => jsonResponse(200, CONTROLS),
    'GET /bastion/api/v1/setup': () => jsonResponse(200, setupState({ frameworks: [{ id: 'f-soc', name: 'SOC 2' }] })),
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ControlsPage', () => {
  it('shows the "Not set up yet" count, the denominator, requirement chips and plain states', async () => {
    wrap(<ControlsPage onNavigate={() => {}} />);
    expect(await screen.findByTestId('not-set-up-count')).toHaveTextContent('Not set up yet: 4');
    expect(screen.getByText('44 of 48 controls set up')).toBeInTheDocument();
    expect(screen.getByText('CC6.1')).toBeInTheDocument();
    expect(screen.getByText('A.5.17')).toBeInTheDocument();
    expect(screen.getByText('Does not apply (1)')).toBeInTheDocument();
    expect(screen.getAllByText('Not set up yet')).toHaveLength(1);
    // No raw ids on the default view.
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('asks for the framework view when one is picked', async () => {
    const { qc } = wrap(<ControlsPage onNavigate={() => {}} />);
    await screen.findByTestId('not-set-up-count');
    fireEvent.change(await screen.findByLabelText('Framework'), { target: { value: 'f-soc' } });
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => new URL(String(u)).searchParams.get('framework_id') === 'f-soc')).toBe(true),
    );
    await settled(qc);
  });

  it('teaches the next step when nothing is adopted', async () => {
    fetchMock = routedFetch({
      'GET /bastion/api/v1/controls': () => jsonResponse(200, { data: [], counts: { total: 0, set_up: 0, not_set_up: 0, not_applicable: 0 }, framework_id: null }),
      'GET /bastion/api/v1/setup': () => jsonResponse(200, setupState()),
    });
    vi.stubGlobal('fetch', fetchMock);
    const onNavigate = vi.fn();
    wrap(<ControlsPage onNavigate={onNavigate} />);
    expect(await screen.findByText('Adopt a framework in Setup to see your controls.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Go to Setup' }));
    expect(onNavigate).toHaveBeenCalledWith('/setup');
  });

  it('tells someone who cannot adopt a framework to ask an admin, with no Setup button (#194)', async () => {
    fetchMock = routedFetch({
      'GET /bastion/api/v1/controls': () => jsonResponse(200, { data: [], counts: { total: 0, set_up: 0, not_set_up: 0, not_applicable: 0 }, framework_id: null }),
      'GET /bastion/api/v1/setup': () => jsonResponse(200, setupState()),
    });
    vi.stubGlobal('fetch', fetchMock);
    wrap(<ControlsPage onNavigate={() => {}} />, VIEWER_PERMISSIONS);
    expect(await screen.findByText('No framework has been adopted yet. Ask an admin to set up Bastion.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Go to Setup' })).toBeNull();
  });

  it('a refused load reads as a plain sentence (#194)', async () => {
    fetchMock = routedFetch({
      'GET /bastion/api/v1/controls': () =>
        jsonResponse(403, { error: { code: 'PERMISSION_DENIED', message: 'Permission denied: bastion.control.read' } }),
      'GET /bastion/api/v1/setup': () => jsonResponse(200, setupState()),
    });
    vi.stubGlobal('fetch', fetchMock);
    wrap(<ControlsPage onNavigate={() => {}} />, VIEWER_PERMISSIONS);
    expect(await screen.findByText('You do not have permission to do this. Ask an admin of your organization.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('bastion.control.read');
  });
});
