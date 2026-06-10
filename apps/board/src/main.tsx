import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PermissionsProvider } from '@bigbluebam/ui/permissions-context';
import {
  mountBureauClient,
  type LocationDescriptor,
} from '@bigbluebam/bureau-client';
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
// Board shares Bam's session and reads /b3/api/auth/me directly.
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
// Board surfaces the active canvas id as `surface_id` so the unified call
// manager (Phase 1) derives the canonical `huddle-board-{id}` LiveKit room
// from it. The old per-canvas `board-<id>` room name is dead with Phase 2.
function describeLocation(): LocationDescriptor | undefined {
  const path = window.location.pathname;
  if (!path.startsWith('/board')) return undefined;
  const tail = path.slice('/board'.length) || '/';
  // Matches /board/:id (canvas) and /board/:id/versions
  const m = tail.match(/^\/([^/]+)(?:\/versions)?$/);
  let surface_id: string | undefined;
  if (m && !['new', 'templates', 'starred', 'archived', 'help', ''].includes(m[1]!)) {
    surface_id = m[1]!;
  }
  return {
    url: window.location.origin + path,
    app: 'board',
    label: path,
    surface_id,
  };
}

try {
  const mount = mountBureauClient({
    describeLocation,
    initialRoute: window.location.pathname,
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
  const onChange = () => mount.setRoute(window.location.pathname);
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
  console.warn('[board] mountBureauClient failed', err);
}
