import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { BayLayout } from '@/components/layout/bay-layout';
import { ReviewLibraryPage } from '@/pages/review-library';
import { ReviewAssetPage } from '@/pages/review-asset';
import { ReviewByBinAsset } from '@/pages/review-by-bin';
import { GuestReviewPage } from '@/pages/guest-review';
import { HelpViewer } from '@bigbluebam/ui/help-viewer';
import { Loader2 } from 'lucide-react';

type Route =
  | { page: 'assets' }
  | { page: 'review'; id: string }
  | { page: 'review-by-bin'; binAssetId: string }
  | { page: 'guest-review'; token: string }
  | { page: 'help' };

const BASE_PATH = '/bay';

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) {
    return path.slice(BASE_PATH.length) || '/';
  }
  return path;
}

function parseRoute(path: string): Route {
  const p = stripBase(path);

  if (p === '/' || p === '') return { page: 'assets' };
  if (p === '/help') return { page: 'help' };

  // /r/:token — public guest review (no auth). Checked early; rendered before
  // the auth guard so anonymous browsers can open shared links.
  const guestMatch = p.match(/^\/r\/([^/]+)$/);
  if (guestMatch) return { page: 'guest-review', token: guestMatch[1]! };

  // /assets/:id — the review page (by Bay asset id)
  const reviewMatch = p.match(/^\/assets\/([^/]+)$/);
  if (reviewMatch) return { page: 'review', id: reviewMatch[1]! };

  // /review/:binAssetId — open a review by Bin asset id (handled on first load
  // too, so the Bin SPA can deep-link here with a full-page navigation).
  const byBinMatch = p.match(/^\/review\/([^/]+)$/);
  if (byBinMatch) return { page: 'review-by-bin', binAssetId: byBinMatch[1]! };

  return { page: 'assets' };
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

  // Public guest review bypasses auth entirely — render before the loading/auth
  // gate so a shared /r/:token link works for anonymous browsers.
  if (route.page === 'guest-review') {
    return <GuestReviewPage token={route.token} />;
  }

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
          <h1 className="text-2xl font-bold">Bay Media Review</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Bay.</p>
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
    return <HelpViewer appSlug="bay" onBack={() => navigate('/')} />;
  }

  const renderPage = () => {
    switch (route.page) {
      case 'assets':
        return <ReviewLibraryPage onNavigate={navigate} />;
      case 'review':
        return <ReviewAssetPage assetId={route.id} onNavigate={navigate} />;
      case 'review-by-bin':
        return <ReviewByBinAsset binAssetId={route.binAssetId} onNavigate={navigate} />;
      default:
        return null;
    }
  };

  return (
    <BayLayout onNavigate={navigate} activeRoute={route}>
      {renderPage()}
    </BayLayout>
  );
}
