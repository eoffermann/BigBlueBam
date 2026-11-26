// Issue #158: both Launchpad editors render a row for EVERY catalog app, and
// unticking one app saves "all apps minus that one", never a 14-app list that
// silently hides every newer app.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { LAUNCHPAD_APP_IDS, ROOT_REDIRECT_VALUES } from '@bigbluebam/shared';

const { get, put } = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock('@/lib/api', () => ({
  api: { get: (...a: unknown[]) => get(...a), put: (...a: unknown[]) => put(...a), patch: vi.fn(), post: vi.fn() },
  ApiError: class ApiError extends Error {},
}));

import { OrgLaunchpadTab } from '@/pages/settings';
import { LaunchpadDefaultsCard } from '@/pages/superuser/index';
import { launchpadRows, rootRedirectOptions } from '@/lib/launchpad-catalog';

// What the api's LAUNCHPAD_CATALOG sends: every shared id with a display name.
const CATALOG = LAUNCHPAD_APP_IDS.map((id) => ({
  id,
  name: `App ${id}`,
  description: `About ${id}`,
  icon_name: 'x',
  color: '#000',
  path: `/${id}/`,
}));
const NEWER = ['blueprint', 'bin', 'bay', 'blip', 'bureau', 'basis', 'braid', 'bulwark', 'burn', 'bursar'];

function wrap(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  get.mockReset();
  put.mockReset();
  put.mockResolvedValue({ data: {} });
});
afterEach(cleanup);

describe('Org Launchpad tab (settings)', () => {
  beforeEach(() => {
    get.mockImplementation(async (path: string) => {
      if (path === '/org/launchpad-apps') {
        return { data: { catalog: [...LAUNCHPAD_APP_IDS], catalog_detail: CATALOG, org_override: null, platform_default: null } };
      }
      throw new Error(`unexpected GET ${path}`);
    });
  });

  it('renders a row for every catalog app, including the newer ones', async () => {
    wrap(<OrgLaunchpadTab canEdit />);
    for (const app of CATALOG) expect(await screen.findByText(app.name)).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(LAUNCHPAD_APP_IDS.length);
  });

  it('switching to a custom list and unticking one app saves every other app', async () => {
    wrap(<OrgLaunchpadTab canEdit />);
    await screen.findByText('App bill');
    fireEvent.click(screen.getByRole('button', { name: /custom for this org/i }));
    const billRow = screen.getByText('App bill').closest('label')!;
    fireEvent.click(within(billRow).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const [path, body] = put.mock.calls[0] as [string, { apps: string[] }];
    expect(path).toBe('/org/launchpad-apps');
    expect(body.apps).toHaveLength(LAUNCHPAD_APP_IDS.length - 1);
    expect(body.apps).not.toContain('bill');
    for (const id of NEWER) expect(body.apps).toContain(id);
  });
});

describe('SuperUser Launchpad defaults card', () => {
  beforeEach(() => {
    get.mockImplementation(async (path: string) => {
      if (path === '/launchpad/apps') return { data: { catalog: [...LAUNCHPAD_APP_IDS], catalog_detail: CATALOG } };
      if (path === '/system-settings/launchpad_default_apps') throw new Error('404');
      throw new Error(`unexpected GET ${path}`);
    });
  });

  it('renders a row for every catalog app', async () => {
    wrap(<LaunchpadDefaultsCard />);
    for (const app of CATALOG) expect(await screen.findByText(app.name)).toBeInTheDocument();
  });

  it('unticking one app from "all enabled" saves all the others, newer apps included', async () => {
    wrap(<LaunchpadDefaultsCard />);
    const row = (await screen.findByText('App board')).closest('label')!;
    fireEvent.click(within(row).getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const [path, body] = put.mock.calls[0] as [string, { value: string[] }];
    expect(path).toBe('/system-settings/launchpad_default_apps');
    expect(body.value).toHaveLength(LAUNCHPAD_APP_IDS.length - 1);
    expect(body.value).not.toContain('board');
    for (const id of NEWER) expect(body.value).toContain(id);
  });
});

describe('launchpad-catalog helpers', () => {
  it('never drops a shared id the server did not describe', () => {
    const rows = launchpadRows(CATALOG.slice(0, 3));
    expect(rows.map((r) => r.id)).toEqual([...LAUNCHPAD_APP_IDS]);
  });

  it('root-redirect options are the site plus every app', () => {
    const opts = rootRedirectOptions(launchpadRows(CATALOG));
    expect(opts.map((o) => o.value)).toEqual([...ROOT_REDIRECT_VALUES]);
    expect(opts.find((o) => o.value === 'bursar')!.label).toBe('App bursar (/bursar/)');
  });
});
