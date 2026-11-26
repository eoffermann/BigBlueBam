import { useState, useEffect, useCallback } from 'react';
import { Castle, Loader2 } from 'lucide-react';
import { openHelpCenter } from '@bigbluebam/ui/help-center';
import { useAuthStore } from '@/stores/auth.store';
import { BastionLayout, type ActiveRoute } from '@/components/layout/bastion-layout';
import { HomePage } from '@/pages/home';
import { SetupPage } from '@/pages/setup';
import { ControlsPage } from '@/pages/controls';

// Grows one variant per page as later milestones land (spec 6.1).
type Route = { page: 'home' } | { page: 'setup' } | { page: 'controls' };

const BASE_PATH = '/bastion';

export function parseRoute(path: string): Route {
  const rest = path.startsWith(BASE_PATH) ? path.slice(BASE_PATH.length) : path;
  const clean = rest.replace(/\/+$/, '');
  if (clean === '/setup') return { page: 'setup' };
  if (clean === '/controls') return { page: 'controls' };
  return { page: 'home' };
}

function toActiveRoute(route: Route): ActiveRoute {
  return { page: route.page };
}

export function App() {
  const { isAuthenticated, isLoading, fetchMe } = useAuthStore();
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

  // Apply saved theme on mount (matches the sibling SPAs).
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
    const handlePopState = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback((path: string) => {
    const fullPath = `${BASE_PATH}${path}`;
    window.history.pushState(null, '', fullPath);
    setRoute(parseRoute(fullPath));
  }, []);

  // ? opens Help (matches bursar / burn / blip).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (e.key === '?' && !isInInput && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        openHelpCenter('bastion');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-50 dark:bg-zinc-950">
        <div className="flex flex-col items-center gap-4">
          <div className="flex items-center justify-center h-14 w-14 rounded-2xl bg-primary-600 text-white">
            <Castle className="h-7 w-7" />
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
          <h1 className="text-2xl font-bold">Bastion</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Bastion.</p>
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
      case 'home':
        return <HomePage />;
      case 'setup':
        return <SetupPage />;
      case 'controls':
        return <ControlsPage onNavigate={navigate} />;
      default:
        return null;
    }
  };

  return (
    <BastionLayout onNavigate={navigate} activeRoute={toActiveRoute(route)}>
      {renderPage()}
    </BastionLayout>
  );
}
