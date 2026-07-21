import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { BoltLayout } from '@/components/layout/bolt-layout';
import { HomePage } from '@/pages/home';
import { AutomationEditorPage } from '@/pages/automation-editor';
import { AutomationExecutionsPage } from '@/pages/automation-executions';
import { ExecutionLogPage } from '@/pages/execution-log';
import { ExecutionDetailPage } from '@/pages/execution-detail';
import { TemplateBrowserPage } from '@/pages/template-browser';
import { openHelpCenter } from '@bigbluebam/ui/help-center';
import { Loader2 } from 'lucide-react';

type Route =
  | { page: 'home' }
  | { page: 'new' }
  | { page: 'editor'; id: string }
  | { page: 'automation-executions'; id: string }
  | { page: 'executions' }
  | { page: 'execution-detail'; id: string }
  | { page: 'templates' };

const BASE_PATH = '/bolt';

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) {
    return path.slice(BASE_PATH.length) || '/';
  }
  return path;
}

function parseRoute(path: string): Route {
  const p = stripBase(path);

  if (p === '/' || p === '') return { page: 'home' };
  if (p === '/new') return { page: 'new' };
  if (p === '/templates') return { page: 'templates' };
  if (p === '/executions') return { page: 'executions' };

  // /automations/:id/executions
  const automationExecMatch = p.match(/^\/automations\/([^/]+)\/executions$/);
  if (automationExecMatch) {
    return { page: 'automation-executions', id: automationExecMatch[1]! };
  }

  // /automations/:id
  const automationMatch = p.match(/^\/automations\/([^/]+)$/);
  if (automationMatch) {
    return { page: 'editor', id: automationMatch[1]! };
  }

  // /executions/:id
  const executionMatch = p.match(/^\/executions\/([^/]+)$/);
  if (executionMatch) {
    return { page: 'execution-detail', id: executionMatch[1]! };
  }

  return { page: 'home' };
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
        openHelpCenter('bolt');
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
          <h1 className="text-2xl font-bold">Bolt</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Bolt.</p>
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
      case 'new':
        return <AutomationEditorPage onNavigate={navigate} />;
      case 'editor':
        return <AutomationEditorPage id={route.id} onNavigate={navigate} />;
      case 'automation-executions':
        return <AutomationExecutionsPage automationId={route.id} onNavigate={navigate} />;
      case 'executions':
        return <ExecutionLogPage onNavigate={navigate} />;
      case 'execution-detail':
        return <ExecutionDetailPage id={route.id} onNavigate={navigate} />;
      case 'templates':
        return <TemplateBrowserPage onNavigate={navigate} />;
      default:
        return null;
    }
  };

  return (
    <BoltLayout onNavigate={navigate} activeRoute={route}>
      {renderPage()}
    </BoltLayout>
  );
}
