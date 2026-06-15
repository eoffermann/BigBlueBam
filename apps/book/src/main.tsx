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
initSystemErrorReporter({ service: 'book' });
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

// Wave E.D: per-action permission matrix fetcher for the `useCan` hook.
// Book shares Bam's session and reads /b3/api/auth/me directly.
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

// ─── Bureau-client mount (workstream 13 + D-4) ───────────────────────────
// Event-detail pages advertise the event id as surface_id so the docked
// box auto-joins the event's canonical room (huddle-book-{eventId}) —
// that's what makes a book_events.meeting_url deep link a working call.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function describeLocation(): LocationDescriptor | undefined {
  const path = window.location.pathname;
  if (!path.startsWith('/book')) return undefined;
  const eventMatch = path.match(/^\/book\/events\/([^/]+)$/);
  const surface_id =
    eventMatch && UUID_RE.test(eventMatch[1]!) ? eventMatch[1]! : undefined;
  return {
    // Include the query string so the reported location carries any deep-link
    // state (e.g. a future ?tab=/?drawer= param) along with the path. Bureau
    // invite/summon sends this url verbatim and the receiving navigate()
    // preserves the search, so a teammate you bring lands on the exact record
    // you have open. surface_id stays path-derived — the event id lives in the
    // path, not the query.
    url: window.location.origin + path + window.location.search,
    app: 'book',
    label: path,
    surface_id,
  };
}

try {
  const mount = mountBureauClient({
    describeLocation,
    // Key the route trigger on pathname+search so a query-only change still
    // re-announces the deep link (matches describeLocation, which reports the
    // search).
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
  console.warn('[book] mountBureauClient failed', err);
}
