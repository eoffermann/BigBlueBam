import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { HelpViewer } from '@bigbluebam/ui/help-viewer';
import { useAuthStore } from '@/stores/auth.store';
import { BlueprintLayout } from '@/components/layout/blueprint-layout';
import { DiagramListPage } from '@/pages/list';
import { EditorPage } from '@/pages/editor';
import { useDiagrams } from '@/hooks/use-diagrams';
import type { DiagramFilterKey } from '@/components/layout/blueprint-sidebar';

type Route =
  | { page: 'list' }
  | { page: 'editor'; id: string }
  | { page: 'help' };

const BASE_PATH = '/blueprint';

function stripBase(path: string): string {
  if (path.startsWith(BASE_PATH)) {
    return path.slice(BASE_PATH.length) || '/';
  }
  return path;
}

function parseRoute(path: string): Route {
  const p = stripBase(path);
  if (p === '/' || p === '') return { page: 'list' };
  if (p === '/help') return { page: 'help' };
  const editorMatch = p.match(/^\/d\/([^/]+)$/);
  if (editorMatch) return { page: 'editor', id: editorMatch[1]! };
  return { page: 'list' };
}

export function App() {
  const { isAuthenticated, isLoading, fetchMe } = useAuthStore();
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.pathname));
  const [activeFilter, setActiveFilter] = useState<DiagramFilterKey>('all');
  const [newDialogOpen, setNewDialogOpen] = useState(false);

  // Sidebar count badges. We fetch the unfiltered list (including
  // archived) once and derive the per-type/starred/archived totals
  // client-side so the badges update with the same data the list
  // page is already rendering.
  const overviewQuery = useDiagrams({ include_archived: true });
  const counts = useMemo(() => {
    const list = overviewQuery.data?.data ?? [];
    const byType: Record<string, number> = {};
    let starred = 0;
    let archived = 0;
    let total = 0;
    for (const d of list) {
      if (d.is_archived) {
        archived++;
        continue;
      }
      total++;
      if (d.starred) starred++;
      byType[d.diagram_type] = (byType[d.diagram_type] ?? 0) + 1;
    }
    return { byType, starred, archived, total };
  }, [overviewQuery.data?.data]);

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
    const fullPath = `${BASE_PATH}${path === '/' ? '' : path}` || `${BASE_PATH}/`;
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
          <h1 className="text-2xl font-bold">Blueprint</h1>
          <p className="text-zinc-400">Please log in to BigBlueBam first to access Blueprint.</p>
          <a href="/b3/" className="inline-block px-4 py-2 bg-primary-600 text-white rounded-lg hover:bg-primary-700">
            Go to BigBlueBam Login
          </a>
        </div>
      </div>
    );
  }

  if (route.page === 'help') {
    return <HelpViewer appSlug="blueprint" onBack={() => navigate('/')} />;
  }

  const renderPage = () => {
    switch (route.page) {
      case 'list':
        return (
          <DiagramListPage
            onNavigate={navigate}
            filter={activeFilter}
            newDialogOpen={newDialogOpen}
            onNewDialogOpenChange={setNewDialogOpen}
          />
        );
      case 'editor':
        return <EditorPage diagramId={route.id} onNavigate={navigate} />;
      default:
        return null;
    }
  };

  return (
    <BlueprintLayout
      onNavigate={navigate}
      activeRoute={route}
      activeFilter={activeFilter}
      onFilterChange={setActiveFilter}
      diagramTypeCounts={counts.byType}
      totalCount={counts.total}
      starredCount={counts.starred}
      archivedCount={counts.archived}
      onNewDiagram={() => setNewDialogOpen(true)}
      fullBleed={route.page === 'editor'}
    >
      {renderPage()}
    </BlueprintLayout>
  );
}
