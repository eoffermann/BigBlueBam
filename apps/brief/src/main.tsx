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
      staleTime: 1000 * 60, // 60s — documents change moderately often
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

// Wave E.D: per-action permission matrix fetcher for the `useCan` hook.
// Brief shares Bam's session and reads /b3/api/auth/me directly.
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
// Brief documents have a per-document LiveKit room (`brief-<idOrSlug>`).
// We expose it on `livekitRoom` whenever the route is /documents/:id or
// /documents/:id/edit so summons can offer continuous-audio handoff.
function describeLocation(): LocationDescriptor | undefined {
  const path = window.location.pathname;
  if (!path.startsWith('/brief')) return undefined;
  const tail = path.slice('/brief'.length) || '/';
  const m = tail.match(/^\/documents\/([^/]+)(?:\/edit)?$/);
  const livekitRoom = m ? `brief-${m[1]}` : undefined;
  return {
    url: window.location.origin + path,
    app: 'brief',
    label: path,
    livekitRoom,
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
  console.warn('[brief] mountBureauClient failed', err);
}
