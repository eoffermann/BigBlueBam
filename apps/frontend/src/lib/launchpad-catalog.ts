// Launchpad app rows for the admin editors (issue #158).
//
// The Org settings Launchpad tab and the SuperUser Launchpad-defaults card used
// to hand-code a 14-app list. Unticking one app saved "those 14 minus one", which
// silently hid every newer app suite-wide, and the newer apps never rendered as
// rows, so nobody could see or undo it. The rows now come from the server's
// LAUNCHPAD_CATALOG (`catalog_detail`), and the id set is backstopped by the
// shared LAUNCHPAD_APP_IDS, so no app can drop out of the list.
import { useQuery } from '@tanstack/react-query';
import { LAUNCHPAD_APP_IDS, ROOT_REDIRECT_VALUES } from '@bigbluebam/shared';
import { api } from '@/lib/api';

export interface LaunchpadRow {
  id: string;
  name: string;
  description: string;
  path: string;
}

type Detail = Partial<LaunchpadRow> & { id: string };

/**
 * Every Launchpad app, in display order: the server's catalog rows first, then
 * any shared-list id the server did not describe (shown by its id, never dropped).
 */
export function launchpadRows(detail?: readonly Detail[] | null): LaunchpadRow[] {
  const out: LaunchpadRow[] = [];
  const seen = new Set<string>();
  for (const d of detail ?? []) {
    if (!d?.id || seen.has(d.id)) continue;
    seen.add(d.id);
    out.push({ id: d.id, name: d.name ?? d.id, description: d.description ?? '', path: d.path ?? `/${d.id}/` });
  }
  for (const id of LAUNCHPAD_APP_IDS) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: id, description: '', path: `/${id}/` });
  }
  return out;
}

/** The full catalog from GET /launchpad/apps (any signed-in user). */
export function useLaunchpadCatalog(): LaunchpadRow[] {
  const { data } = useQuery({
    queryKey: ['launchpad', 'apps', 'catalog'],
    queryFn: () => api.get<{ data: { catalog_detail?: Detail[] } }>('/launchpad/apps'),
    staleTime: 5 * 60 * 1000,
  });
  return launchpadRows(data?.data?.catalog_detail);
}

/** Options for the SuperUser root-redirect picker: the site plus every app. */
export function rootRedirectOptions(rows: LaunchpadRow[]): { value: string; label: string }[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ROOT_REDIRECT_VALUES.map((value) => {
    if (value === 'site') return { value, label: 'Marketing Site (/)' };
    const row = byId.get(value);
    return { value, label: row ? `${row.name} (${row.path})` : `${value} (/${value}/)` };
  });
}
