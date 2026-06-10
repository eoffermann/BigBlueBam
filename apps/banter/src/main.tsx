import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PermissionsProvider } from '@bigbluebam/ui/permissions-context';
import {
  mountBureauClient,
  type LocationDescriptor,
} from '@bigbluebam/bureau-client';
import { App } from './App';
import { ErrorBoundary } from './components/error-boundary';
import './styles/globals.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30, // 30s — messages should feel fresh
      retry: 1,
      refetchOnWindowFocus: true,
    },
  },
});

// Wave E.D: per-action permission matrix fetcher for the `useCan` hook.
// Banter doesn't have its own /auth/me; it reuses Bam's shared session
// via the cross-app /b3/api/auth/me endpoint (see auth.store.ts).
const fetchAuthMe = async (): Promise<{ data: { permissions?: Record<string, boolean> } }> => {
  const res = await fetch('/b3/api/auth/me', { credentials: 'include' });
  if (!res.ok) return { data: {} };
  return res.json();
};

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('Root element not found');

createRoot(rootElement).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <PermissionsProvider fetcher={fetchAuthMe}>
          <App />
        </PermissionsProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);

// ─── Bureau-client mount (workstream 13 + Phase 2 unified LiveKit) ───────
// Reports the current route to Bureau so summons can teleport this user
// from another app AND so the Bureau docked-box can derive the canonical
// huddle room for the surface the user is viewing. Channel routes resolve
// slug → channel.id via window.__banterChannelIndex (published by
// useChannels() in hooks/use-channels.ts); the bureau-client then joins
// `huddle-banter-{channel_id}`. Two users on the same channel land in the
// same LiveKit room with no Banter-side call signaling.

function describeLocation(): LocationDescriptor | undefined {
  const path = window.location.pathname;
  if (!path.startsWith('/banter')) return undefined;

  // /banter/channels/:slug  → surface_id = channel.id (resolved via map)
  const channelMatch = path.match(/^\/banter\/channels\/([^/]+)$/);
  if (channelMatch) {
    const slug = channelMatch[1]!;
    const channelId = window.__banterChannelIndex?.[slug];
    if (channelId) {
      return {
        url: window.location.origin + path,
        app: 'banter',
        label: `#${slug}`,
        surface_id: channelId,
      };
    }
    // Channel list hasn't loaded yet — emit location without surface_id
    // so summon still works. The huddle target backfills on the next
    // setRoute() call after the channels query resolves.
    return {
      url: window.location.origin + path,
      app: 'banter',
      label: `#${slug}`,
    };
  }

  // /banter/dm/:id  → :id is already the channel id
  const dmMatch = path.match(/^\/banter\/dm\/([^/]+)$/);
  if (dmMatch) {
    return {
      url: window.location.origin + path,
      app: 'banter',
      label: 'DM',
      surface_id: dmMatch[1]!,
    };
  }

  return {
    url: window.location.origin + path,
    app: 'banter',
    label: path,
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
  // When the channels query resolves, re-evaluate describeLocation()
  // so a fresh page load that lands on /banter/channels/:slug picks up
  // the surface_id once the slug→id map is available.
  window.addEventListener('banter:channels-updated', onChange);
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
  console.warn('[banter] mountBureauClient failed', err);
}
