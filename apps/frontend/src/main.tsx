import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PermissionsProvider } from '@bigbluebam/ui/permissions-context';
import {
  initSystemErrorReporter,
  mountBureauClient,
  type LocationDescriptor,
} from '@bigbluebam/bureau-client';
import { App } from './App';
import { api } from './lib/api';
import './styles/globals.css';

// Install the browser-side system_errors reporter as early as
// possible so even an error during initial render gets captured.
initSystemErrorReporter({ service: 'b3' });

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

// Wave E.D: per-action permission matrix fetcher consumed by the `useCan`
// hook in @bigbluebam/ui/use-can. The api client returns the parsed
// `{ data: { permissions, ... } }` envelope, which is exactly the shape
// `PermissionsFetcher` expects.
const fetchAuthMe = () =>
  api.getQuiet<{ data: { permissions?: Record<string, boolean> } }>('/auth/me');

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
// Bam's SPA lives at /b3/. Bureau identifies it as `b3`.
function describeLocation(): LocationDescriptor | undefined {
  const path = window.location.pathname;
  if (!path.startsWith('/b3')) return undefined;
  // Include the query string so the reported location carries deep-link state
  // like `?task=<id>` (the open task drawer). Bureau invite/summon sends this
  // url verbatim, and the receiving navigate() preserves the search, so a
  // teammate you pull in lands on the exact task you have open — not the bare
  // board. The label stays the bare path (task-drawer labels are layered in
  // separately via useBureauLocationLabel).
  return {
    url: window.location.origin + path + window.location.search,
    app: 'b3',
    label: path,
  };
}

try {
  const mount = mountBureauClient({
    describeLocation,
    // Include the search string in the route trigger: opening a task drawer
    // changes only `?task=<id>` (same pathname), and describeLocation already
    // reports the query. Keying the reactor on pathname alone meant the
    // location relay never re-ran on a query-only change, so the open task was
    // never reported and Invite/Bring/summon sent the bare board URL. Keying on
    // pathname+search makes a drawer open/close re-announce the exact deep link.
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
  window.history.pushState = (...args: Parameters<typeof origPush>) => {
    const ret = origPush(...args);
    onChange();
    return ret;
  };
  window.history.replaceState = (...args: Parameters<typeof origReplace>) => {
    const ret = origReplace(...args);
    onChange();
    return ret;
  };
} catch (err) {
  // eslint-disable-next-line no-console
  console.warn('[b3] mountBureauClient failed', err);
}
