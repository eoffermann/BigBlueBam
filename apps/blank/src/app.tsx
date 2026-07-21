import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { BlankLayout } from '@/components/layout/blank-layout';
import { FormListPage } from '@/pages/form-list';
import { FormBuilderPage } from '@/pages/form-builder';
import { FormPreviewPage } from '@/pages/form-preview';
import { FormResponsesPage } from '@/pages/form-responses';
import { FormAnalyticsPage } from '@/pages/form-analytics';
import { FormSettingsPage } from '@/pages/form-settings';
import { SettingsPage } from '@/pages/settings';
import { PublicFormPage } from '@/pages/public-form';
import { openHelpCenter } from '@bigbluebam/ui/help-center';
import { Loader2 } from 'lucide-react';

type Route =
  | { page: 'forms' }
  | { page: 'form-builder'; id: string }
  | { page: 'form-preview'; id: string }
  | { page: 'form-responses'; id: string }
  | { page: 'form-analytics'; id: string }
  | { page: 'form-settings'; id: string }
  | { page: 'settings' }
  | { page: 'public-form'; slug: string };

const BASE_PATH = '/blank';

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) {
    return path.slice(BASE_PATH.length) || '/';
  }
  return path;
}

function parseRoute(path: string): Route {
  const p = stripBase(path);

  if (p === '/' || p === '') return { page: 'forms' };
  if (p === '/settings') return { page: 'settings' };

  // /f/:slug — public form render (no auth required)
  const publicMatch = p.match(/^\/f\/([^/]+)$/);
  if (publicMatch) return { page: 'public-form', slug: publicMatch[1]! };

  // /forms/new
  if (p === '/forms/new') return { page: 'form-builder', id: 'new' };

  // /forms/:id/edit
  const editMatch = p.match(/^\/forms\/([^/]+)\/edit$/);
  if (editMatch) return { page: 'form-builder', id: editMatch[1]! };

  // /forms/:id/preview
  const previewMatch = p.match(/^\/forms\/([^/]+)\/preview$/);
  if (previewMatch) return { page: 'form-preview', id: previewMatch[1]! };

  // /forms/:id/responses
  const responsesMatch = p.match(/^\/forms\/([^/]+)\/responses$/);
  if (responsesMatch) return { page: 'form-responses', id: responsesMatch[1]! };

  // /forms/:id/analytics
  const analyticsMatch = p.match(/^\/forms\/([^/]+)\/analytics$/);
  if (analyticsMatch) return { page: 'form-analytics', id: analyticsMatch[1]! };

  // /forms/:id/settings
  const settingsMatch = p.match(/^\/forms\/([^/]+)\/settings$/);
  if (settingsMatch) return { page: 'form-settings', id: settingsMatch[1]! };

  return { page: 'forms' };
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

  // Public form render bypasses auth entirely. A public form URL should
  // work for anonymous browsers with no BigBlueBam session cookie.
  if (route.page === 'public-form') {
    return <PublicFormPage slug={route.slug} />;
  }

  // ? keyboard shortcut to open Help
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isInInput = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
      if (e.key === '?' && !isInInput && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        openHelpCenter('blank');
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
          <h1 className="text-2xl font-bold">Blank Forms & Surveys</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Blank.</p>
          <a href="/b3/" className="inline-block px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700">
            Go to BigBlueBam Login
          </a>
        </div>
      </div>
    );
  }

  const renderPage = () => {
    switch (route.page) {
      case 'forms':
        return <FormListPage onNavigate={navigate} />;
      case 'form-builder':
        return <FormBuilderPage formId={route.id} onNavigate={navigate} />;
      case 'form-preview':
        return <FormPreviewPage formId={route.id} onNavigate={navigate} />;
      case 'form-responses':
        return <FormResponsesPage formId={route.id} onNavigate={navigate} />;
      case 'form-analytics':
        return <FormAnalyticsPage formId={route.id} onNavigate={navigate} />;
      case 'form-settings':
        return <FormSettingsPage formId={route.id} onNavigate={navigate} />;
      case 'settings':
        return <SettingsPage onNavigate={navigate} />;
      // 'public-form' handled by the early return above; excluded from the
      // narrowed union that reaches this switch.
      default:
        return null;
    }
  };

  return (
    <BlankLayout onNavigate={navigate} activeRoute={route}>
      {renderPage()}
    </BlankLayout>
  );
}
