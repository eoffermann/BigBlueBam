import { useState, useEffect, useCallback } from 'react';
import { ShoppingCart, Loader2 } from 'lucide-react';
import { openHelpCenter } from '@bigbluebam/ui/help-center';
import { useAuthStore } from '@/stores/auth.store';
import { BursarLayout, type ActiveRoute } from '@/components/layout/bursar-layout';
import { VendorPortfolioPage } from '@/pages/vendor-portfolio';
import { RequestsListPage } from '@/pages/requests-list';
import { RequestScopePage } from '@/pages/request-scope';
import { LevelingMatrixPage } from '@/pages/leveling-matrix';
import { ExclusionDiffPage } from '@/pages/exclusion-diff';
import { VendorDetailPage } from '@/pages/vendor-detail';
import { MismatchInboxPage } from '@/pages/mismatch-inbox';
import { RenewalRadarPage } from '@/pages/renewal-radar';
import { ReviewQueuePage } from '@/pages/review-queue';
import { SettingsPage } from '@/pages/settings';

type Route =
  | { page: 'board' }
  | { page: 'requests' }
  | { page: 'request-scope'; id: string }
  | { page: 'request-level'; id: string }
  | { page: 'request-diff'; id: string }
  | { page: 'vendor-detail'; id: string }
  | { page: 'mismatches' }
  | { page: 'renewals' }
  | { page: 'review' }
  | { page: 'settings' };

const BASE_PATH = '/bursar';

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) return path.slice(BASE_PATH.length) || '/';
  return path;
}

function parseRoute(path: string): Route {
  const p = stripBase((path.split('?')[0] ?? path).replace(/\/+$/, '') || '/');

  if (p === '/' || p === '') return { page: 'board' };
  if (p === '/requests') return { page: 'requests' };
  if (p === '/mismatches') return { page: 'mismatches' };
  if (p === '/renewals') return { page: 'renewals' };
  if (p === '/review') return { page: 'review' };
  if (p === '/settings') return { page: 'settings' };

  const level = p.match(/^\/requests\/([^/]+)\/level$/);
  if (level) return { page: 'request-level', id: level[1]! };
  const diff = p.match(/^\/requests\/([^/]+)\/diff$/);
  if (diff) return { page: 'request-diff', id: diff[1]! };
  const scope = p.match(/^\/requests\/([^/]+)$/);
  if (scope) return { page: 'request-scope', id: scope[1]! };

  const vendor = p.match(/^\/vendors\/([^/]+)$/);
  if (vendor) return { page: 'vendor-detail', id: vendor[1]! };

  return { page: 'board' };
}

function toActiveRoute(route: Route): ActiveRoute {
  switch (route.page) {
    case 'request-scope':
    case 'request-level':
    case 'request-diff':
    case 'vendor-detail':
      return { page: route.page, id: route.id };
    case 'board':
    case 'requests':
    case 'mismatches':
    case 'renewals':
    case 'review':
    case 'settings':
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

  // ? opens Help (matches burn / blip).
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInInput =
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (e.key === '?' && !isInInput && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        openHelpCenter('bursar');
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
            <ShoppingCart className="h-7 w-7" />
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
          <h1 className="text-2xl font-bold">Bursar</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Bursar.</p>
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
        return <VendorPortfolioPage onNavigate={navigate} />;
      case 'requests':
        return <RequestsListPage onNavigate={navigate} />;
      case 'request-scope':
        return <RequestScopePage requestId={route.id} onNavigate={navigate} />;
      case 'request-level':
        return <LevelingMatrixPage requestId={route.id} onNavigate={navigate} />;
      case 'request-diff':
        return <ExclusionDiffPage requestId={route.id} onNavigate={navigate} />;
      case 'vendor-detail':
        return <VendorDetailPage vendorId={route.id} onNavigate={navigate} />;
      case 'mismatches':
        return <MismatchInboxPage onNavigate={navigate} />;
      case 'renewals':
        return <RenewalRadarPage onNavigate={navigate} />;
      case 'review':
        return <ReviewQueuePage onNavigate={navigate} />;
      case 'settings':
        return <SettingsPage />;
      default:
        return null;
    }
  };

  return (
    <BursarLayout onNavigate={navigate} activeRoute={toActiveRoute(route)}>
      {renderPage()}
    </BursarLayout>
  );
}
