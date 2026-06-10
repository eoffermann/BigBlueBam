/**
 * Bureau SPA entry.
 *
 * Boots:
 *   - StrictMode + QueryClientProvider for TanStack Query.
 *   - PermissionsProvider that pulls /b3/api/auth/me (Bam owns the session).
 *   - mountBureauClient() so the docked-box, summon toasts, and knock toasts
 *     all render here too — every other SPA in the suite carries the same
 *     mount; the Bureau SPA is no exception.
 *
 * The mountBureauClient describeLocation() returns the Bureau route the user
 * is currently looking at, so a summon from another app can teleport the
 * user back to a specific floor.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PermissionsProvider } from '@bigbluebam/ui/permissions-context';
import {
  mountBureauClient,
  type LocationDescriptor,
  type UnmountFn,
} from '@bigbluebam/bureau-client';
import { App, type Route } from './App';
import './styles/globals.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30,
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

// Per-action permission matrix fetcher for the shared `useCan` hook.
// Bureau shares Bam's session and reads /b3/api/auth/me directly.
const fetchAuthMe = async (): Promise<{ data: { permissions?: Record<string, boolean> } }> => {
  const res = await fetch('/b3/api/auth/me', { credentials: 'include' });
  if (!res.ok) return { data: {} };
  return res.json();
};

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');

// ─── Bureau-client mount ─────────────────────────────────────────────────
// describeLocation maps the in-app route to the §11 location descriptor.
// We only emit a descriptor for routes that name a specific resource (a
// floor); the floor list itself has no canonical "thing being viewed"
// from a teleport's perspective.

function describeBureauLocation(route: unknown): LocationDescriptor | undefined {
  if (!route || typeof route !== 'object') return undefined;
  const r = route as Route;
  if (r.page === 'floor') {
    return {
      url: `${window.location.origin}/bureau/floors/${r.id}`,
      app: 'bureau',
      label: 'Floor',
    };
  }
  if (r.page === 'admin-floor') {
    return {
      url: `${window.location.origin}/bureau/admin/floors/${r.id}`,
      app: 'bureau',
      label: 'Floor editor',
    };
  }
  return undefined;
}

let bureauMount: UnmountFn | null = null;
try {
  bureauMount = mountBureauClient({
    describeLocation: describeBureauLocation,
    navigate: (url: string) => {
      // Summons fire SPA-internal navigations; strip the origin and use
      // history.pushState + a popstate dispatch so our hand-rolled router
      // re-parses the URL.
      try {
        const u = new URL(url, window.location.origin);
        const path = u.pathname + u.search + u.hash;
        window.history.pushState(null, '', path);
        window.dispatchEvent(new PopStateEvent('popstate'));
      } catch {
        window.location.href = url;
      }
    },
  });
} catch (err) {
  // Don't block the SPA from rendering if the WS handshake throws — the
  // floor view's own useBureauWs hook will still drive the live data.
  // eslint-disable-next-line no-console
  console.warn('[bureau] mountBureauClient failed', err);
}

// Keep the SDK's route mirror in sync with our in-app router so describeLocation
// gets the live value on every navigation.
function onRouteChange(route: Route) {
  bureauMount?.setRoute(route);
}

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <PermissionsProvider fetcher={fetchAuthMe}>
        <App onRouteChange={onRouteChange} />
      </PermissionsProvider>
    </QueryClientProvider>
  </StrictMode>,
);
