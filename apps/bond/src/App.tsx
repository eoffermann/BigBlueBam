import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { BondLayout } from '@/components/layout/bond-layout';
import { PipelineBoardPage } from '@/pages/pipeline-board';
import { DealDetailPage } from '@/pages/deal-detail';
import { ContactListPage } from '@/pages/contact-list';
import { ContactDetailPage } from '@/pages/contact-detail';
import { CompanyListPage } from '@/pages/company-list';
import { CompanyDetailPage } from '@/pages/company-detail';
import { AnalyticsPage } from '@/pages/analytics';
import { SettingsPage } from '@/pages/settings';
import { ErrorBoundary } from '@/components/common/error-boundary';
import { HelpViewer } from '@bigbluebam/ui/help-viewer';
import { Loader2 } from 'lucide-react';

type Route =
  | { page: 'pipeline' }
  | { page: 'pipeline-detail'; id: string }
  | { page: 'deal-detail'; id: string }
  | { page: 'contacts' }
  | { page: 'contact-detail'; id: string }
  | { page: 'companies' }
  | { page: 'company-detail'; id: string }
  | { page: 'analytics' }
  | { page: 'settings'; tab: 'pipelines' | 'fields' | 'scoring' }
  | { page: 'help' };

const BASE_PATH = '/bond';

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) {
    return path.slice(BASE_PATH.length) || '/';
  }
  return path;
}

function parseRoute(path: string): Route {
  const p = stripBase(path);

  if (p === '/' || p === '') return { page: 'pipeline' };
  if (p === '/help') return { page: 'help' };
  if (p === '/contacts') return { page: 'contacts' };
  if (p === '/companies') return { page: 'companies' };
  if (p === '/analytics') return { page: 'analytics' };

  // /settings/:tab
  const settingsMatch = p.match(/^\/settings\/(pipelines|fields|scoring)$/);
  if (settingsMatch) {
    return { page: 'settings', tab: settingsMatch[1] as 'pipelines' | 'fields' | 'scoring' };
  }
  if (p.startsWith('/settings')) {
    return { page: 'settings', tab: 'pipelines' };
  }

  // /deals/:id
  const dealMatch = p.match(/^\/deals\/([^/]+)$/);
  if (dealMatch) {
    return { page: 'deal-detail', id: dealMatch[1]! };
  }

  // /contacts/:id
  const contactMatch = p.match(/^\/contacts\/([^/]+)$/);
  if (contactMatch) {
    return { page: 'contact-detail', id: contactMatch[1]! };
  }

  // /companies/:id
  const companyMatch = p.match(/^\/companies\/([^/]+)$/);
  if (companyMatch) {
    return { page: 'company-detail', id: companyMatch[1]! };
  }

  // /pipelines/:id
  const pipelineMatch = p.match(/^\/pipelines\/([^/]+)$/);
  if (pipelineMatch) {
    return { page: 'pipeline-detail', id: pipelineMatch[1]! };
  }

  return { page: 'pipeline' };
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
          <h1 className="text-2xl font-bold">Bond CRM</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Bond.</p>
          <a href="/b3/" className="inline-block px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700">
            Go to BigBlueBam Login
          </a>
        </div>
      </div>
    );
  }

  if (route.page === 'help') {
    return <HelpViewer appSlug="bond" onBack={() => navigate('/')} />;
  }

  const renderPage = () => {
    switch (route.page) {
      case 'pipeline':
        return <PipelineBoardPage onNavigate={navigate} />;
      case 'pipeline-detail':
        return <PipelineBoardPage onNavigate={navigate} pipelineId={route.id} />;
      case 'deal-detail':
        return <DealDetailPage dealId={route.id} onNavigate={navigate} />;
      case 'contacts':
        return <ContactListPage onNavigate={navigate} />;
      case 'contact-detail':
        return <ContactDetailPage contactId={route.id} onNavigate={navigate} />;
      case 'companies':
        return <CompanyListPage onNavigate={navigate} />;
      case 'company-detail':
        return <CompanyDetailPage companyId={route.id} onNavigate={navigate} />;
      case 'analytics':
        return <AnalyticsPage onNavigate={navigate} />;
      case 'settings':
        return <SettingsPage onNavigate={navigate} activeTab={route.tab} />;
      default:
        return null;
    }
  };

  return (
    <BondLayout onNavigate={navigate} activeRoute={route}>
      {/* Remount the boundary per route so an error on one page does not
          permanently wedge navigation to others. */}
      <ErrorBoundary key={route.page}>{renderPage()}</ErrorBoundary>
    </BondLayout>
  );
}
