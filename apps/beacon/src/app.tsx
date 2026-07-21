import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { BeaconLayout } from '@/components/layout/beacon-layout';
import { ErrorBoundary } from '@/components/error-boundary';
import { HomePage } from '@/pages/home';
import { BeaconListPage } from '@/pages/beacon-list';
import { BeaconSearchPage } from '@/pages/beacon-search';
import { BeaconDetailPage } from '@/pages/beacon-detail';
import { BeaconEditorPage } from '@/pages/beacon-editor';
import { GraphExplorerPage } from '@/pages/graph-explorer';
import { BeaconDashboardPage } from '@/pages/beacon-dashboard';
import { BeaconSettingsPage } from '@/pages/beacon-settings';
import { openHelpCenter } from '@bigbluebam/ui/help-center';
import { Loader2 } from 'lucide-react';

type Route =
  | { page: 'home' }
  | { page: 'list' }
  | { page: 'search' }
  | { page: 'detail'; idOrSlug: string }
  | { page: 'create' }
  | { page: 'edit'; idOrSlug: string }
  | { page: 'graph'; focalId?: string }
  | { page: 'dashboard' }
  | { page: 'settings' };

const BASE_PATH = '/beacon';

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) {
    return path.slice(BASE_PATH.length) || '/';
  }
  return path;
}

function parseRoute(path: string): Route {
  const p = stripBase(path);

  if (p === '/' || p === '') return { page: 'home' };
  if (p === '/list') return { page: 'list' };
  if (p === '/search') return { page: 'search' };
  if (p === '/create') return { page: 'create' };
  if (p === '/dashboard') return { page: 'dashboard' };
  if (p === '/settings') return { page: 'settings' };

  const editMatch = p.match(/^\/([^/]+)\/edit$/);
  if (editMatch) {
    return { page: 'edit', idOrSlug: editMatch[1]! };
  }

  const graphMatch = p.match(/^\/graph(?:\/([^/]+))?$/);
  if (graphMatch) {
    return { page: 'graph', focalId: graphMatch[1] };
  }

  const detailMatch = p.match(/^\/([^/]+)$/);
  if (detailMatch) {
    return { page: 'detail', idOrSlug: detailMatch[1]! };
  }

  return { page: 'home' };
}

export function App() {
  const { isAuthenticated, isLoading, fetchMe } = useAuthStore();
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  // Apply saved theme on mount
  useEffect(() => {
    const savedTheme = localStorage.getItem('bbam-theme') ?? 'system';
    const root = document.documentElement;
    root.classList.remove('dark');
    if (savedTheme === 'dark') {
      root.classList.add('dark');
    } else if (savedTheme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      root.classList.add('dark');
    }
  }, []);

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

  // ? keyboard shortcut to open Help
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (e.key === '?' && !isInInput && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        openHelpCenter('beacon');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

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
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-950 text-zinc-100">
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold">Beacon</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Beacon.</p>
          <a href="/b3/" className="inline-block px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700">
            Go to BigBlueBam Login
          </a>
        </div>
      </div>
    );
  }

  const renderPage = () => {
    switch (route.page) {
      case 'home':
        return <HomePage onNavigate={navigate} />;
      case 'list':
        return <BeaconListPage onNavigate={navigate} />;
      case 'search':
        return <BeaconSearchPage onNavigate={navigate} />;
      case 'detail':
        return <BeaconDetailPage idOrSlug={route.idOrSlug} onNavigate={navigate} />;
      case 'create':
        return <BeaconEditorPage onNavigate={navigate} />;
      case 'edit':
        return <BeaconEditorPage idOrSlug={route.idOrSlug} onNavigate={navigate} />;
      case 'graph':
        return <GraphExplorerPage focalId={route.focalId} onNavigate={navigate} />;
      case 'dashboard':
        return <BeaconDashboardPage onNavigate={navigate} />;
      case 'settings':
        return <BeaconSettingsPage onNavigate={navigate} />;
      default:
        return null;
    }
  };


  // Build a stable key from the current route so the boundary auto-resets
  // when the user navigates away from a crashed page.
  const routeKey =
    route.page +
    ('idOrSlug' in route ? `:${route.idOrSlug}` : '') +
    ('focalId' in route && route.focalId ? `:${route.focalId}` : '');

  return (
    <BeaconLayout onNavigate={navigate} activeRoute={route}>
      <ErrorBoundary resetKey={routeKey}>{renderPage()}</ErrorBoundary>
    </BeaconLayout>
  );
}
