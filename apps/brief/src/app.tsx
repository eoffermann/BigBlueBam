import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { BriefLayout } from '@/components/layout/brief-layout';
import { HomePage } from '@/pages/home';
import { DocumentListPage } from '@/pages/document-list';
import { DocumentDetailPage } from '@/pages/document-detail';
import { DocumentEditorPage } from '@/pages/document-editor';
import { TemplateBrowserPage } from '@/pages/template-browser';
import { SearchPage } from '@/pages/search-page';
import { StarredPage } from '@/pages/starred-page';
import { openHelpCenter } from '@bigbluebam/ui/help-center';
import { Loader2 } from 'lucide-react';

type Route =
  | { page: 'home' }
  | { page: 'documents'; folderId?: string | null }
  | { page: 'detail'; idOrSlug: string }
  | { page: 'edit'; idOrSlug: string }
  | { page: 'templates' }
  | { page: 'search' }
  | { page: 'new' }
  | { page: 'starred' };

const BASE_PATH = '/brief';

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) {
    return path.slice(BASE_PATH.length) || '/';
  }
  return path;
}

function parseRoute(pathWithQuery: string): Route {
  // Split off query string for route parsing, but keep search params available
  // for the documents page (folder filter).
  const [path, queryStr = ''] = pathWithQuery.split('?', 2);
  const p = stripBase(path ?? '');
  const qp = new URLSearchParams(queryStr);
  const folderId = qp.get('folder');

  if (p === '/' || p === '') return { page: 'home' };
  if (p === '/documents') return { page: 'documents', folderId: folderId || null };
  if (p === '/templates') return { page: 'templates' };
  if (p === '/search') return { page: 'search' };
  if (p === '/new') return { page: 'new' };
  if (p === '/starred') return { page: 'starred' };

  const editMatch = p.match(/^\/documents\/([^/]+)\/edit$/);
  if (editMatch) {
    return { page: 'edit', idOrSlug: editMatch[1]! };
  }

  const detailMatch = p.match(/^\/documents\/([^/]+)$/);
  if (detailMatch) {
    return { page: 'detail', idOrSlug: detailMatch[1]! };
  }

  return { page: 'home' };
}

export function App() {
  const { isAuthenticated, isLoading, fetchMe } = useAuthStore();
  const [route, setRoute] = useState<Route>(() =>
    parseRoute(window.location.pathname + window.location.search),
  );

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
      setRoute(parseRoute(window.location.pathname + window.location.search));
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
        openHelpCenter('brief');
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
          <h1 className="text-2xl font-bold">Brief</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Brief.</p>
          <a href="/b3/" className="inline-block px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700">
            Go to BigBlueBam Login
          </a>
        </div>
      </div>
    );
  }

  const renderPage = () => {
    switch (route.page) {
      case 'home':
        return <HomePage onNavigate={navigate} />;
      case 'documents':
        return <DocumentListPage onNavigate={navigate} folderId={route.folderId ?? null} />;
      case 'detail':
        return <DocumentDetailPage idOrSlug={route.idOrSlug} onNavigate={navigate} />;
      case 'edit':
        return <DocumentEditorPage idOrSlug={route.idOrSlug} onNavigate={navigate} />;
      case 'templates':
        return <TemplateBrowserPage onNavigate={navigate} />;
      case 'search':
        return <SearchPage onNavigate={navigate} />;
      case 'new':
        return <DocumentEditorPage onNavigate={navigate} />;
      case 'starred':
        return <StarredPage onNavigate={navigate} />;
      default:
        return null;
    }
  };

  return (
    <BriefLayout onNavigate={navigate} activeRoute={route}>
      {renderPage()}
    </BriefLayout>
  );
}
