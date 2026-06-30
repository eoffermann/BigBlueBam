import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { BlipLayout, type ActiveRoute } from '@/components/layout/blip-layout';
import { AppListPage } from '@/pages/app-list';
import { AppDetailPage } from '@/pages/app-detail';
import { KeyManagementPage } from '@/pages/key-management';
import { ClientSetupPage } from '@/pages/client-setup';
import { LiveViewerPage } from '@/pages/live-viewer';
import { ReportTypesPage } from '@/pages/report-types';
import { SavedViewsPage } from '@/pages/saved-views';
import { WatchManagementPage } from '@/pages/watch-management';
import { TransformEditorPage } from '@/pages/transform-editor';
import { RetentionSettingsPage } from '@/pages/retention-settings';
import { HelpViewer } from '@bigbluebam/ui/help-viewer';
import { Loader2 } from 'lucide-react';

type Route =
  | { page: 'apps' }
  | { page: 'app-detail'; id: string }
  | { page: 'keys'; id: string }
  | { page: 'client-setup'; id: string }
  | { page: 'watches'; id: string }
  | { page: 'views'; id: string }
  | { page: 'transform'; id: string }
  | { page: 'retention'; id: string }
  | { page: 'types'; id: string }
  | { page: 'viewer'; id: string; reportType: string }
  | { page: 'help' };

const BASE_PATH = '/blip';

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) {
    return path.slice(BASE_PATH.length) || '/';
  }
  return path;
}

function parseRoute(path: string): Route {
  const p = stripBase(path);

  if (p === '/' || p === '') return { page: 'apps' };
  if (p === '/help') return { page: 'help' };

  // /apps/:id/types/:t — live viewer (checked before the bare /types route)
  const viewerMatch = p.match(/^\/apps\/([^/]+)\/types\/([^/]+)$/);
  if (viewerMatch) {
    return { page: 'viewer', id: viewerMatch[1]!, reportType: decodeURIComponent(viewerMatch[2]!) };
  }

  const subMatch = p.match(/^\/apps\/([^/]+)\/([a-z-]+)$/);
  if (subMatch) {
    const id = subMatch[1]!;
    const sub = subMatch[2]!;
    switch (sub) {
      case 'keys':
        return { page: 'keys', id };
      case 'client-setup':
        return { page: 'client-setup', id };
      case 'watches':
        return { page: 'watches', id };
      case 'views':
        return { page: 'views', id };
      case 'transform':
        return { page: 'transform', id };
      case 'retention':
        return { page: 'retention', id };
      case 'types':
        return { page: 'types', id };
      default:
        return { page: 'app-detail', id };
    }
  }

  const appMatch = p.match(/^\/apps\/([^/]+)$/);
  if (appMatch) return { page: 'app-detail', id: appMatch[1]! };

  return { page: 'apps' };
}

function toActiveRoute(route: Route): ActiveRoute {
  if ('id' in route) {
    return {
      page: route.page,
      id: route.id,
      reportType: route.page === 'viewer' ? route.reportType : undefined,
    };
  }
  return { page: route.page };
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
      const isInInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (e.key === '?' && !isInInput && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        navigate('/help');
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
          <h1 className="text-2xl font-bold">Blip Telemetry</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Blip.</p>
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

  if (route.page === 'help') {
    return <HelpViewer appSlug="blip" onBack={() => navigate('/')} />;
  }

  const renderPage = () => {
    switch (route.page) {
      case 'apps':
        return <AppListPage onNavigate={navigate} />;
      case 'app-detail':
        return <AppDetailPage appId={route.id} onNavigate={navigate} />;
      case 'keys':
        return <KeyManagementPage appId={route.id} />;
      case 'client-setup':
        return <ClientSetupPage appId={route.id} />;
      case 'types':
        return <ReportTypesPage appId={route.id} onNavigate={navigate} />;
      case 'viewer':
        return <LiveViewerPage appId={route.id} reportType={route.reportType} />;
      case 'views':
        return <SavedViewsPage appId={route.id} />;
      case 'watches':
        return <WatchManagementPage appId={route.id} />;
      case 'transform':
        return <TransformEditorPage appId={route.id} />;
      case 'retention':
        return <RetentionSettingsPage appId={route.id} />;
      default:
        return null;
    }
  };

  return (
    <BlipLayout onNavigate={navigate} activeRoute={toActiveRoute(route)}>
      {renderPage()}
    </BlipLayout>
  );
}
