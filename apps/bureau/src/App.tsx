/**
 * Bureau SPA root.
 *
 * Routes:
 *   '/'                   → floor list (user-facing landing)
 *   '/floors/:id'         → live floor view (canvas + WS presence)
 *   '/admin/floors'       → admin floor list (create / edit / archive / restore)
 *   '/admin/floors/:id'   → admin floor editor (canvas room placement)
 *
 * The router is intentionally simple (no react-router): the suite uses
 * matching hand-rolled routers across every SPA. Pattern mirrors
 * apps/blueprint/src/app.tsx.
 */

import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useAuthStore } from '@/stores/auth.store';
import { BureauLayout } from '@/components/layout/bureau-layout';
import { FloorListPage } from '@/pages/floor-list';
import { FloorViewPage } from '@/pages/floor-view';
import { AdminFloorListPage } from '@/pages/admin/floor-list';
import { FloorEditorPage } from '@/pages/admin/floor-editor';
import { AdminOfficesPage } from '@/pages/admin/offices';

export type Route =
  | { page: 'floor-list' }
  | { page: 'floor'; id: string }
  | { page: 'admin-floor-list' }
  | { page: 'admin-floor'; id: string }
  | { page: 'admin-offices' };

const BASE_PATH = '/bureau';

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) {
    return path.slice(BASE_PATH.length) || '/';
  }
  return path;
}

export function parseRoute(path: string): Route {
  const p = stripBase(path);
  if (p === '/' || p === '') return { page: 'floor-list' };
  const floorMatch = p.match(/^\/floors\/([^/]+)$/);
  if (floorMatch) return { page: 'floor', id: floorMatch[1]! };
  if (p === '/admin/floors' || p === '/admin/floors/') {
    return { page: 'admin-floor-list' };
  }
  const adminFloorMatch = p.match(/^\/admin\/floors\/([^/]+)$/);
  if (adminFloorMatch) return { page: 'admin-floor', id: adminFloorMatch[1]! };
  if (p === '/admin/offices' || p === '/admin/offices/') {
    return { page: 'admin-offices' };
  }
  return { page: 'floor-list' };
}

export interface AppProps {
  /**
   * Optional setter so main.tsx can keep the mountBureauClient route in sync
   * with the in-app router (the SDK calls describeLocation() with this value).
   */
  onRouteChange?: (route: Route) => void;
}

export function App({ onRouteChange }: AppProps = {}) {
  const { isAuthenticated, isLoading, fetchMe } = useAuthStore();
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [activeFloorName, setActiveFloorName] = useState<string | undefined>();

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  // Apply saved theme on mount (mirrors every other SPA in the suite).
  useEffect(() => {
    const savedTheme = localStorage.getItem('bbam-theme') ?? 'system';
    const root = document.documentElement;
    root.classList.remove('dark');
    if (savedTheme === 'dark') {
      root.classList.add('dark');
    } else if (
      savedTheme === 'system' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches
    ) {
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

  useEffect(() => {
    onRouteChange?.(route);
  }, [route, onRouteChange]);

  const navigate = useCallback((path: string) => {
    const fullPath = `${BASE_PATH}${path === '/' ? '' : path}` || `${BASE_PATH}/`;
    window.history.pushState(null, '', fullPath);
    setRoute(parseRoute(fullPath));
  }, []);

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
          <h1 className="text-2xl font-bold">Bureau</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Bureau.</p>
          <a
            href="/b3/"
            className="inline-block px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700"
          >
            Go to BigBlueBam Login
          </a>
        </div>
      </div>
    );
  }

  const activeFloorId =
    route.page === 'floor' || route.page === 'admin-floor' ? route.id : null;

  const renderPage = () => {
    switch (route.page) {
      case 'floor-list':
        return <FloorListPage onNavigate={navigate} />;
      case 'floor':
        return (
          <FloorViewPage
            floorId={route.id}
            onFloorLoaded={(name) => setActiveFloorName(name)}
          />
        );
      case 'admin-floor-list':
        return <AdminFloorListPage onNavigate={navigate} />;
      case 'admin-floor':
        return <FloorEditorPage floorId={route.id} onNavigate={navigate} />;
      case 'admin-offices':
        return <AdminOfficesPage />;
      default:
        return null;
    }
  };

  return (
    <BureauLayout
      onNavigate={navigate}
      activeRoute={route}
      activeFloorId={activeFloorId}
      activeFloorName={activeFloorName}
      fullBleed={route.page === 'floor'}
    >
      {renderPage()}
    </BureauLayout>
  );
}
