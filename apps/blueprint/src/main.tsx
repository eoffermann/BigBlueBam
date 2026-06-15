import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PermissionsProvider } from '@bigbluebam/ui/permissions-context';
import {
  initSystemErrorReporter,
  mountBureauClient,
  type LocationDescriptor,
} from '@bigbluebam/bureau-client';

// Browser-side system_errors reporter — every error a user sees in
// this SPA forwards to the SuperUser Log Analysis tab. Initialised as
// the first thing after imports so errors during boot are caught.
initSystemErrorReporter({ service: 'blueprint' });
import { App } from './app';
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
// Blueprint shares Bam's session and reads /b3/api/auth/me directly.
const fetchAuthMe = async (): Promise<{ data: { permissions?: Record<string, boolean> } }> => {
  const res = await fetch('/b3/api/auth/me', { credentials: 'include' });
  if (!res.ok) return { data: {} };
  return res.json();
};

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <PermissionsProvider fetcher={fetchAuthMe}>
        <App />
      </PermissionsProvider>
    </QueryClientProvider>
  </StrictMode>,
);

// ─── Bureau-client mount (workstream 13) ─────────────────────────────────
function describeLocation(): LocationDescriptor | undefined {
  const path = window.location.pathname;
  if (!path.startsWith('/blueprint')) return undefined;
  // Include the query string so the reported location carries deep-link state
  // like `?node=<id>` (the selected graph node). Bureau invite/summon sends
  // this url verbatim, and the receiving navigate() preserves the search, so a
  // teammate you pull in lands on the exact diagram (and node) you have open —
  // not the bare diagram. The label stays the bare path.
  return {
    url: window.location.origin + path + window.location.search,
    app: 'blueprint',
    label: path,
  };
}

try {
  const mount = mountBureauClient({
    describeLocation,
    // Include the search string in the route trigger: selecting a node changes
    // only `?node=<id>` (same pathname), and describeLocation already reports
    // the query. Keying the reactor on pathname alone meant a query-only change
    // never re-ran the location relay, so the selected node was never reported
    // and Invite/Bring/summon sent the bare diagram URL. Keying on
    // pathname+search makes a selection change re-announce the exact deep link.
    initialRoute: window.location.pathname + window.location.search,
    navigate: (url: string) => {
      try {
        const u = new URL(url, window.location.origin);
        const target = u.pathname + u.search + u.hash;
        window.history.pushState(null, '', target);
        window.dispatchEvent(new PopStateEvent('popstate'));
      } catch {
        window.location.href = url;
      }
    },
  });
  const onChange = () =>
    mount.setRoute(window.location.pathname + window.location.search);
  window.addEventListener('popstate', onChange);
  const origPush = window.history.pushState.bind(window.history);
  const origReplace = window.history.replaceState.bind(window.history);
  window.history.pushState = function (...args: Parameters<typeof origPush>) {
    const ret = origPush(...args);
    onChange();
    return ret;
  };
  window.history.replaceState = function (...args: Parameters<typeof origReplace>) {
    const ret = origReplace(...args);
    onChange();
    return ret;
  };
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn('[blueprint] mountBureauClient failed', err);
}
