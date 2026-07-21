import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { BenchLayout } from '@/components/layout/bench-layout';
import { DashboardListPage } from '@/pages/dashboard-list';
import { DashboardViewPage } from '@/pages/dashboard-view';
import { DashboardEditPage } from '@/pages/dashboard-edit';
import { WidgetWizardPage } from '@/pages/widget-wizard';
import { WidgetEditPage } from '@/pages/widget-edit';
import { ExplorerPage } from '@/pages/explorer';
import { ReportsPage } from '@/pages/reports';
import { SavedQueriesPage } from '@/pages/saved-queries';
import { SettingsPage } from '@/pages/settings';
import { openHelpCenter } from '@bigbluebam/ui/help-center';
import { Loader2 } from 'lucide-react';

type Route =
  | { page: 'dashboards' }
  | { page: 'dashboard-view'; id: string }
  | { page: 'dashboard-edit'; id: string }
  | { page: 'widget-new'; dashboardId: string }
  | { page: 'widget-edit'; id: string }
  | { page: 'explorer' }
  | { page: 'reports' }
  | { page: 'saved-queries' }
  | { page: 'settings' };

const BASE_PATH = '/bench';

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) {
    return path.slice(BASE_PATH.length) || '/';
  }
  return path;
}

function parseRoute(path: string): Route {
  // Drop any query string before matching path segments; pages that need query
  // params (e.g. the explorer's saved_query_id) read window.location.search.
  const p = stripBase(path).split('?')[0]!;

  if (p === '/' || p === '') return { page: 'dashboards' };
  if (p === '/explorer') return { page: 'explorer' };
  if (p === '/reports') return { page: 'reports' };
  if (p === '/saved-queries') return { page: 'saved-queries' };
  if (p === '/settings') return { page: 'settings' };
  // /dashboards/:id/widgets/new
  const widgetNewMatch = p.match(/^\/dashboards\/([^/]+)\/widgets\/new$/);
  if (widgetNewMatch) return { page: 'widget-new', dashboardId: widgetNewMatch[1]! };

  // Legacy route without dashboard context — redirect to dashboard list
  if (p === '/widgets/new') return { page: 'dashboards' };

  // /dashboards/:id/edit
  const editMatch = p.match(/^\/dashboards\/([^/]+)\/edit$/);
  if (editMatch) return { page: 'dashboard-edit', id: editMatch[1]! };

  // /dashboards/:id
  const viewMatch = p.match(/^\/dashboards\/([^/]+)$/);
  if (viewMatch) return { page: 'dashboard-view', id: viewMatch[1]! };

  // /widgets/:id/edit
  const widgetMatch = p.match(/^\/widgets\/([^/]+)\/edit$/);
  if (widgetMatch) return { page: 'widget-edit', id: widgetMatch[1]! };

  return { page: 'dashboards' };
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
        openHelpCenter('bench');
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
          <h1 className="text-2xl font-bold">Bench Analytics</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Bench.</p>
          <a href="/b3/" className="inline-block px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700">
            Go to BigBlueBam Login
          </a>
        </div>
      </div>
    );
  }

  const renderPage = () => {
    switch (route.page) {
      case 'dashboards':
        return <DashboardListPage onNavigate={navigate} />;
      case 'dashboard-view':
        return <DashboardViewPage dashboardId={route.id} onNavigate={navigate} />;
      case 'dashboard-edit':
        return <DashboardEditPage dashboardId={route.id} onNavigate={navigate} />;
      case 'widget-new':
        return <WidgetWizardPage dashboardId={route.dashboardId} onNavigate={navigate} />;
      case 'widget-edit':
        return <WidgetEditPage widgetId={route.id} onNavigate={navigate} />;
      case 'explorer':
        return <ExplorerPage onNavigate={navigate} />;
      case 'reports':
        return <ReportsPage onNavigate={navigate} />;
      case 'saved-queries':
        return <SavedQueriesPage onNavigate={navigate} />;
      case 'settings':
        return <SettingsPage onNavigate={navigate} />;
      default:
        return null;
    }
  };

  return (
    <BenchLayout onNavigate={navigate} activeRoute={route}>
      {renderPage()}
    </BenchLayout>
  );
}
