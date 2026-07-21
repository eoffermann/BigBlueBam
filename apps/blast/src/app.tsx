import { useState, useEffect, useCallback } from 'react';
import { useAuthStore } from '@/stores/auth.store';
import { BlastLayout } from '@/components/layout/blast-layout';
import { CampaignListPage } from '@/pages/campaign-list';
import { CampaignNewPage } from '@/pages/campaign-new';
import { CampaignDetailPage } from '@/pages/campaign-detail';
import { TemplateGalleryPage } from '@/pages/template-gallery';
import { TemplateEditorPage } from '@/pages/template-editor';
import { SegmentListPage } from '@/pages/segment-list';
import { SegmentBuilderPage } from '@/pages/segment-builder';
import { AnalyticsDashboardPage } from '@/pages/analytics-dashboard';
import { DomainSettingsPage } from '@/pages/domain-settings';
import { SmtpSettingsPage } from '@/pages/smtp-settings';
import { openHelpCenter } from '@bigbluebam/ui/help-center';
import { Loader2 } from 'lucide-react';

type Route =
  | { page: 'campaigns' }
  | { page: 'campaign-new' }
  | { page: 'campaign-detail'; id: string }
  | { page: 'templates' }
  | { page: 'template-new' }
  | { page: 'template-edit'; id: string }
  | { page: 'segments' }
  | { page: 'segment-new' }
  | { page: 'analytics' }
  | { page: 'domain-settings' }
  | { page: 'smtp-settings' };

const BASE_PATH = '/blast';

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) {
    return path.slice(BASE_PATH.length) || '/';
  }
  return path;
}

function parseRoute(path: string): Route {
  const p = stripBase(path);

  if (p === '/' || p === '') return { page: 'campaigns' };
  if (p === '/campaigns/new') return { page: 'campaign-new' };
  if (p === '/templates') return { page: 'templates' };
  if (p === '/templates/new') return { page: 'template-new' };
  if (p === '/segments') return { page: 'segments' };
  if (p === '/segments/new') return { page: 'segment-new' };
  if (p === '/analytics') return { page: 'analytics' };
  if (p === '/settings/domains') return { page: 'domain-settings' };
  if (p === '/settings/smtp') return { page: 'smtp-settings' };

  const campaignMatch = p.match(/^\/campaigns\/([^/]+)$/);
  if (campaignMatch) return { page: 'campaign-detail', id: campaignMatch[1]! };

  const templateEditMatch = p.match(/^\/templates\/([^/]+)\/edit$/);
  if (templateEditMatch) return { page: 'template-edit', id: templateEditMatch[1]! };

  return { page: 'campaigns' };
}

export function App() {
  const { isAuthenticated, isLoading, fetchMe } = useAuthStore();
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));

  useEffect(() => {
    fetchMe();
  }, [fetchMe]);

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
        openHelpCenter('blast');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigate]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-50 dark:bg-zinc-950">
        <div className="flex flex-col items-center gap-4">
          <div className="flex items-center justify-center h-14 w-14 rounded-2xl bg-red-600 text-white font-bold text-2xl">
            B
          </div>
          <Loader2 className="h-6 w-6 animate-spin text-red-500" />
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-950 text-zinc-100">
        <div className="text-center space-y-4">
          <h1 className="text-2xl font-bold">Blast Email Campaigns</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Blast.</p>
          <a href="/b3/" className="inline-block px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700">
            Go to BigBlueBam Login
          </a>
        </div>
      </div>
    );
  }

  const renderPage = () => {
    switch (route.page) {
      case 'campaigns':
        return <CampaignListPage onNavigate={navigate} />;
      case 'campaign-new':
        return <CampaignNewPage onNavigate={navigate} />;
      case 'campaign-detail':
        return <CampaignDetailPage campaignId={route.id} onNavigate={navigate} />;
      case 'templates':
        return <TemplateGalleryPage onNavigate={navigate} />;
      case 'template-new':
        return <TemplateEditorPage onNavigate={navigate} />;
      case 'template-edit':
        return <TemplateEditorPage templateId={route.id} onNavigate={navigate} />;
      case 'segments':
        return <SegmentListPage onNavigate={navigate} />;
      case 'segment-new':
        return <SegmentBuilderPage onNavigate={navigate} />;
      case 'analytics':
        return <AnalyticsDashboardPage onNavigate={navigate} />;
      case 'domain-settings':
        return <DomainSettingsPage />;
      case 'smtp-settings':
        return <SmtpSettingsPage />;
      default:
        return null;
    }
  };

  return (
    <BlastLayout onNavigate={navigate} activeRoute={route}>
      {renderPage()}
    </BlastLayout>
  );
}
