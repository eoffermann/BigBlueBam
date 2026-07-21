import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { BearingLayout } from '@/components/layout/bearing-layout';
import { DashboardPage } from '@/pages/DashboardPage';
import { GoalDetailPage } from '@/pages/GoalDetailPage';
import { PeriodListPage } from '@/pages/PeriodListPage';
import { AtRiskPage } from '@/pages/AtRiskPage';
import { MyGoalsPage } from '@/pages/MyGoalsPage';
import { openHelpCenter } from '@bigbluebam/ui/help-center';
import { Loader2 } from 'lucide-react';

type Route =
  | { page: 'dashboard' }
  | { page: 'periods' }
  | { page: 'goal-detail'; id: string }
  | { page: 'at-risk' }
  | { page: 'my-goals' };

const BASE_PATH = '/bearing';

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) {
    return path.slice(BASE_PATH.length) || '/';
  }
  return path;
}

function parseRoute(path: string): Route {
  const p = stripBase(path);

  if (p === '/' || p === '') return { page: 'dashboard' };
  if (p === '/periods') return { page: 'periods' };
  if (p === '/at-risk') return { page: 'at-risk' };
  if (p === '/my-goals') return { page: 'my-goals' };

  // /goals/:id
  const goalMatch = p.match(/^\/goals\/([^/]+)$/);
  if (goalMatch) {
    return { page: 'goal-detail', id: goalMatch[1]! };
  }

  return { page: 'dashboard' };
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
        openHelpCenter('bearing');
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
          <h1 className="text-2xl font-bold">Bearing</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Bearing.</p>
          <a href="/b3/" className="inline-block px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700">
            Go to BigBlueBam Login
          </a>
        </div>
      </div>
    );
  }


  const renderPage = () => {
    switch (route.page) {
      case 'dashboard':
        return <DashboardPage onNavigate={navigate} />;
      case 'periods':
        return <PeriodListPage onNavigate={navigate} />;
      case 'goal-detail':
        return <GoalDetailPage id={route.id} onNavigate={navigate} />;
      case 'at-risk':
        return <AtRiskPage onNavigate={navigate} />;
      case 'my-goals':
        return <MyGoalsPage onNavigate={navigate} />;
      default:
        return null;
    }
  };

  return (
    <BearingLayout onNavigate={navigate} activeRoute={route}>
      {renderPage()}
    </BearingLayout>
  );
}
