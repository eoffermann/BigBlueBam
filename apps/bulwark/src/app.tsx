import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { BulwarkLayout, type ActiveRoute } from '@/components/layout/bulwark-layout';
import { ObligationLedgerPage } from '@/pages/obligation-ledger';
import { ContractDetailPage } from '@/pages/contract-detail';
import { DeadlineRadarPage } from '@/pages/deadline-radar';
import { NoticeReviewQueuePage } from '@/pages/notice-review-queue';
import { VendorComplianceMatrixPage } from '@/pages/vendor-compliance-matrix';
import { SettingsPage } from '@/pages/settings';
import { openHelpCenter } from '@bigbluebam/ui/help-center';
import { Loader2 } from 'lucide-react';

type Route =
  | { page: 'ledger' }
  | { page: 'contract-detail'; id: string }
  | { page: 'radar' }
  | { page: 'notices' }
  | { page: 'compliance' }
  | { page: 'settings' };

const BASE_PATH = '/bulwark';

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) {
    return path.slice(BASE_PATH.length) || '/';
  }
  return path;
}

function parseRoute(path: string): Route {
  const p = stripBase(path);

  if (p === '/' || p === '') return { page: 'ledger' };
  if (p === '/radar') return { page: 'radar' };
  if (p === '/notices') return { page: 'notices' };
  if (p === '/compliance') return { page: 'compliance' };
  if (p === '/settings') return { page: 'settings' };

  const contractMatch = p.match(/^\/contracts\/([^/]+)$/);
  if (contractMatch) return { page: 'contract-detail', id: contractMatch[1]! };

  return { page: 'ledger' };
}

function toActiveRoute(route: Route): ActiveRoute {
  switch (route.page) {
    case 'contract-detail':
      return { page: 'contract-detail', id: route.id };
    case 'ledger':
    case 'radar':
    case 'notices':
    case 'compliance':
    case 'settings':
      return { page: route.page };
    default:
      return { page: 'ledger' };
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
        openHelpCenter('bulwark');
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
          <h1 className="text-2xl font-bold">Bulwark Contract Monitor</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Bulwark.</p>
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
      case 'ledger':
        return <ObligationLedgerPage onNavigate={navigate} />;
      case 'contract-detail':
        return <ContractDetailPage contractId={route.id} onNavigate={navigate} />;
      case 'radar':
        return <DeadlineRadarPage onNavigate={navigate} />;
      case 'notices':
        return <NoticeReviewQueuePage onNavigate={navigate} />;
      case 'compliance':
        return <VendorComplianceMatrixPage onNavigate={navigate} />;
      case 'settings':
        return <SettingsPage />;
      default:
        return null;
    }
  };

  return (
    <BulwarkLayout onNavigate={navigate} activeRoute={toActiveRoute(route)}>
      {renderPage()}
    </BulwarkLayout>
  );
}
