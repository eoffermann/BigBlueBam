import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { BurnLayout, type ActiveRoute } from '@/components/layout/burn-layout';
import { PortfolioBoardPage } from '@/pages/portfolio-board';
import { UnscopedQueuePage } from '@/pages/unscoped-queue';
import { EngagementDetailPage } from '@/pages/engagement-detail';
import { GateConsolePage } from '@/pages/gate-console';
import { VariancesPage } from '@/pages/variances';
import { CostRatesPage } from '@/pages/cost-rates';
import { SettingsPage } from '@/pages/settings';
import { RulesPage } from '@/pages/rules';
import { openHelpCenter } from '@bigbluebam/ui/help-center';
import { Flame, Loader2 } from 'lucide-react';

type Route =
  | { page: 'board' }
  | { page: 'engagement-detail'; id: string }
  | { page: 'unscoped' }
  | { page: 'gate' }
  | { page: 'variances' }
  | { page: 'cost-rates' }
  | { page: 'settings' }
  | { page: 'rules' };

const BASE_PATH = '/burn';

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) {
    return path.slice(BASE_PATH.length) || '/';
  }
  return path;
}

function parseRoute(path: string): Route {
  const p = stripBase(path.split('?')[0] ?? path);

  if (p === '/' || p === '') return { page: 'board' };
  if (p === '/unscoped') return { page: 'unscoped' };
  if (p === '/gate') return { page: 'gate' };
  if (p === '/variances') return { page: 'variances' };
  if (p === '/settings/cost-rates') return { page: 'cost-rates' };
  if (p === '/settings/rules') return { page: 'rules' };
  if (p === '/settings') return { page: 'settings' };

  const engagementMatch = p.match(/^\/engagements\/([^/]+)$/);
  if (engagementMatch) return { page: 'engagement-detail', id: engagementMatch[1]! };

  return { page: 'board' };
}

function toActiveRoute(route: Route): ActiveRoute {
  switch (route.page) {
    case 'engagement-detail':
      return { page: 'engagement-detail', id: route.id };
    case 'board':
    case 'unscoped':
    case 'gate':
    case 'variances':
    case 'cost-rates':
    case 'settings':
    case 'rules':
      return { page: route.page };
    default:
      return { page: 'board' };
  }
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
        openHelpCenter('burn');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-50 dark:bg-zinc-950">
        <div className="flex flex-col items-center gap-4">
          <div className="flex items-center justify-center h-14 w-14 rounded-2xl bg-primary-600 text-white">
            <Flame className="h-7 w-7" />
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
          <h1 className="text-2xl font-bold">Burn</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Burn.</p>
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

  const renderPage = () => {
    switch (route.page) {
      case 'board':
        return <PortfolioBoardPage onNavigate={navigate} />;
      case 'engagement-detail':
        return <EngagementDetailPage engagementId={route.id} onNavigate={navigate} />;
      case 'unscoped':
        return <UnscopedQueuePage onNavigate={navigate} />;
      case 'gate':
        return <GateConsolePage />;
      case 'variances':
        return <VariancesPage />;
      case 'cost-rates':
        return <CostRatesPage />;
      case 'settings':
        return <SettingsPage onNavigate={navigate} />;
      case 'rules':
        return <RulesPage />;
      default:
        return null;
    }
  };

  return (
    <BurnLayout onNavigate={navigate} activeRoute={toActiveRoute(route)}>
      {renderPage()}
    </BurnLayout>
  );
}
