import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { useChannel } from '@/hooks/use-channels';
import { BanterLayout } from '@/pages/banter-layout';
import { ChannelView } from '@/pages/channel-view';
import { ChannelBrowser } from '@/pages/channel-browser';
import { BookmarksPage } from '@/pages/bookmarks';
import { SearchPage } from '@/pages/search';
import { PreferencesPage } from '@/pages/preferences';
import { AdminPage } from '@/pages/admin';
import { AdminCallingSettingsPage } from '@/pages/admin-calling-settings';
import { CallPlaybackPage } from '@/pages/call-playback';
import { ws } from '@/lib/websocket';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';
import { HelpViewer } from '@bigbluebam/ui/help-viewer';
import { Loader2 } from 'lucide-react';

type Route =
  | { page: 'channel'; slug: string }
  | { page: 'dm'; id: string }
  | { page: 'go'; id: string }
  | { page: 'browse' }
  | { page: 'bookmarks' }
  | { page: 'search' }
  | { page: 'settings' }
  | { page: 'admin' }
  | { page: 'admin-calling' }
  | { page: 'call'; id: string }
  | { page: 'redirect' }
  | { page: 'help' };

const BASE_PATH = '/banter';

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) {
    return path.slice(BASE_PATH.length) || '/';
  }
  return path;
}

function parseRoute(path: string): Route {
  const p = stripBase(path);

  const channelMatch = p.match(/^\/channels\/([^/]+)$/);
  if (channelMatch) {
    return { page: 'channel', slug: channelMatch[1]! };
  }

  const dmMatch = p.match(/^\/dm\/([^/]+)$/);
  if (dmMatch) {
    return { page: 'dm', id: dmMatch[1]! };
  }

  // /go/:channelId — channel-id resolver used by cross-app deep links that
  // only know the canonical channel id (e.g. the Bureau ring handler's
  // surfaceUrlFor for surface_app 'banter'). Redirects to /channels/:slug
  // or /dm/:id once the channel record loads.
  const goMatch = p.match(/^\/go\/([^/]+)$/);
  if (goMatch) {
    return { page: 'go', id: goMatch[1]! };
  }

  const callMatch = p.match(/^\/calls\/([^/]+)$/);
  if (callMatch) {
    return { page: 'call', id: callMatch[1]! };
  }

  if (p === '/browse') return { page: 'browse' };
  if (p === '/bookmarks') return { page: 'bookmarks' };
  if (p === '/search') return { page: 'search' };
  if (p === '/settings') return { page: 'settings' };
  if (p === '/admin/calling') return { page: 'admin-calling' };
  if (p === '/admin') return { page: 'admin' };
  if (p === '/help') return { page: 'help' };

  return { page: 'redirect' };
}

/**
 * Resolver for /banter/go/:channelId. Cross-app callers (Bureau ring
 * accept, entity links) know the channel ID but not its slug/type; this
 * looks the channel up and bounces to the canonical route. Unknown or
 * inaccessible ids fall back to #general.
 */
function GoToChannelRedirect({
  id,
  onNavigate,
}: {
  id: string;
  onNavigate: (path: string) => void;
}) {
  const { data: channel, isError } = useChannel(id);

  useEffect(() => {
    if (channel) {
      onNavigate(
        channel.type === 'dm' || channel.type === 'group_dm'
          ? `/dm/${channel.id}`
          : `/channels/${channel.slug}`,
      );
    } else if (isError) {
      onNavigate('/channels/general');
    }
  }, [channel, isError, onNavigate]);

  return (
    <div className="flex items-center justify-center h-screen bg-zinc-50 dark:bg-zinc-950">
      <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
    </div>
  );
}

export function App() {
  const { isAuthenticated, isLoading, fetchMe } = useAuthStore();
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  // Apply saved theme on mount. Wrap storage + matchMedia access — iPad
  // Safari can throw on localStorage in private/lockdown contexts and on
  // matchMedia under unusual configurations; an unhandled throw here would
  // unmount the tree without the error boundary in main.tsx.
  useEffect(() => {
    let savedTheme = 'system';
    try {
      savedTheme = window.localStorage?.getItem('bbam-theme') ?? 'system';
    } catch {
      // localStorage unavailable — fall back to system theme.
    }
    const root = document.documentElement;
    root.classList.remove('dark');
    if (savedTheme === 'dark') {
      root.classList.add('dark');
      return;
    }
    if (savedTheme === 'system') {
      try {
        if (window.matchMedia?.('(prefers-color-scheme: dark)').matches) {
          root.classList.add('dark');
        }
      } catch {
        // matchMedia unavailable — leave default light theme.
      }
    }
  }, []);

  // Connect WebSocket when authenticated
  useEffect(() => {
    if (isAuthenticated) {
      ws.connect();
      return () => ws.disconnect();
    }
  }, [isAuthenticated]);

  useEffect(() => {
    const handlePopState = () => {
      setRoute(parseRoute(window.location.pathname));
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback((path: string) => {
    const fullPath = `${BASE_PATH}${path}`;
    window.history.pushState(null, '', fullPath);
    setRoute(parseRoute(fullPath));
  }, []);

  // Default route: bounce to #general from inside an effect rather than
  // calling navigate() during render. Calling setState mid-render works in
  // React 19 but can leave the UI stuck on the `return null` branch on
  // some browsers (observed on iPad Safari hitting `/banter/` after the
  // /banter -> /banter/ 301), producing a black screen.
  useEffect(() => {
    if (isAuthenticated && route.page === 'redirect') {
      navigate('/channels/general');
    }
  }, [isAuthenticated, route.page, navigate]);

  // Register keyboard shortcuts
  useKeyboardShortcuts(navigate);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-50 dark:bg-zinc-950">
        <div className="flex flex-col items-center gap-4">
          <div className="flex items-center justify-center h-14 w-14 rounded-2xl bg-primary-600 text-white font-bold text-2xl">
            B
          </div>
          <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    // Show a message with link to Bam login instead of auto-redirect (prevents loops)
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-950 text-zinc-100">
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold">Banter</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Banter.</p>
          <a href="/b3/" className="inline-block px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700">
            Go to BigBlueBam Login
          </a>
        </div>
      </div>
    );
  }

  // Help page renders outside the layout
  if (route.page === 'help') {
    return <HelpViewer appSlug="banter" onBack={() => navigate('/channels/general')} />;
  }

  // Channel-id resolver — show a loader while we look the channel up.
  if (route.page === 'go') {
    return <GoToChannelRedirect id={route.id} onNavigate={navigate} />;
  }

  // Default route: redirect handled by the useEffect above. Show the loader
  // while it bounces so iPad Safari doesn't paint a blank `return null`.
  if (route.page === 'redirect') {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-50 dark:bg-zinc-950">
        <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
      </div>
    );
  }

  const renderPage = () => {
    switch (route.page) {
      case 'channel':
        return <ChannelView slug={route.slug} type="channel" onNavigate={navigate} />;
      case 'dm':
        return <ChannelView slug={route.id} type="dm" onNavigate={navigate} />;
      case 'browse':
        return <ChannelBrowser onNavigate={navigate} />;
      case 'bookmarks':
        return <BookmarksPage onNavigate={navigate} />;
      case 'search':
        return <SearchPage onNavigate={navigate} />;
      case 'settings':
        return <PreferencesPage onNavigate={navigate} />;
      case 'admin':
        return <AdminPage onNavigate={navigate} />;
      case 'admin-calling':
        return <AdminCallingSettingsPage onNavigate={navigate} />;
      case 'call':
        return <CallPlaybackPage callId={route.id} onNavigate={navigate} />;
      default:
        return null;
    }
  };

  return (
    <BanterLayout onNavigate={navigate} activeRoute={route}>
      {renderPage()}
    </BanterLayout>
  );
}
