import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { BraidLayout, type ActiveRoute } from '@/components/layout/braid-layout';
import { ProfileCatalogPage } from '@/pages/profile-catalog';
import { ProfileDetailPage } from '@/pages/profile-detail';
import { ReviewQueuePage } from '@/pages/review-queue';
import { SurvivorshipRulesPage } from '@/pages/survivorship-rules';
import { SettingsPage } from '@/pages/settings';
import { HelpViewer } from '@bigbluebam/ui/help-viewer';
import { Loader2 } from 'lucide-react';

type Route =
  | { page: 'profiles' }
  | { page: 'profile-detail'; id: string }
  | { page: 'review-queue' }
  | { page: 'survivorship' }
  | { page: 'settings' }
  | { page: 'help' };

const BASE_PATH = '/braid';

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) {
    return path.slice(BASE_PATH.length) || '/';
  }
  return path;
}

function parseRoute(path: string): Route {
  const p = stripBase(path);

  if (p === '/' || p === '') return { page: 'profiles' };
  if (p === '/help') return { page: 'help' };
  if (p === '/review-queue') return { page: 'review-queue' };
  if (p === '/survivorship') return { page: 'survivorship' };
  if (p === '/settings') return { page: 'settings' };

  const profileMatch = p.match(/^\/profiles\/([^/]+)$/);
  if (profileMatch) return { page: 'profile-detail', id: profileMatch[1]! };

  return { page: 'profiles' };
}

function toActiveRoute(route: Route): ActiveRoute {
  switch (route.page) {
    case 'profile-detail':
      return { page: 'profile-detail', id: route.id };
    case 'profiles':
    case 'review-queue':
    case 'survivorship':
    case 'settings':
      return { page: route.page };
    default:
      return { page: 'profiles' };
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
          <h1 className="text-2xl font-bold">Braid Identity Resolution</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Braid.</p>
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
    return <HelpViewer appSlug="braid" onBack={() => navigate('/')} />;
  }

  const renderPage = () => {
    switch (route.page) {
      case 'profiles':
        return <ProfileCatalogPage onNavigate={navigate} />;
      case 'profile-detail':
        return <ProfileDetailPage profileId={route.id} onNavigate={navigate} />;
      case 'review-queue':
        return <ReviewQueuePage onNavigate={navigate} />;
      case 'survivorship':
        return <SurvivorshipRulesPage />;
      case 'settings':
        return <SettingsPage />;
      default:
        return null;
    }
  };

  return (
    <BraidLayout onNavigate={navigate} activeRoute={toActiveRoute(route)}>
      {renderPage()}
    </BraidLayout>
  );
}
