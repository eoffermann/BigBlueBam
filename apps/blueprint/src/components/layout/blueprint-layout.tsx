import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Launchpad, LaunchpadTrigger } from '@bigbluebam/ui/launchpad';
import { OrgSwitcher } from '@bigbluebam/ui/org-switcher';
import { NotificationsBell } from '@bigbluebam/ui/notifications-bell';
import { ImpersonationBanner } from '@bigbluebam/ui/impersonation-banner';
import { HelpTrigger } from '@bigbluebam/ui/help-center';
import { UserMenu } from '@bigbluebam/ui/user-menu';
import { BlueprintSidebar, type DiagramFilterKey } from '@/components/layout/blueprint-sidebar';
import { useAuthStore } from '@/stores/auth.store';

type ActiveRoute = { page: string; id?: string };

interface BlueprintLayoutProps {
  children: ReactNode;
  onNavigate: (path: string) => void;
  activeRoute: ActiveRoute;
  activeFilter: DiagramFilterKey;
  onFilterChange: (filter: DiagramFilterKey) => void;
  diagramTypeCounts?: Record<string, number>;
  totalCount?: number;
  starredCount?: number;
  archivedCount?: number;
  onNewDiagram: () => void;
  /** When true (editor page) the sidebar collapses to maximize canvas. */
  fullBleed?: boolean;
}

type Crumb = { label: string; href?: string };

function breadcrumbsFor(route: ActiveRoute): Crumb[] {
  switch (route.page) {
    case 'list':
      return [{ label: 'Diagrams' }];
    case 'editor':
      return [
        { label: 'Diagrams', href: '/' },
        { label: 'Editor' },
      ];
    default:
      return [];
  }
}

export function BlueprintLayout({
  children,
  onNavigate,
  activeRoute,
  activeFilter,
  onFilterChange,
  diagramTypeCounts,
  totalCount,
  starredCount,
  archivedCount,
  onNewDiagram,
  fullBleed,
}: BlueprintLayoutProps) {
  const user = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const fetchMe = useAuthStore((s) => s.fetchMe);
  const crumbs = breadcrumbsFor(activeRoute);
  const [launchpadOpen, setLaunchpadOpen] = useState(false);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-zinc-50 dark:bg-zinc-950">
      <ImpersonationBanner />
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar - hidden on full-bleed editor pages to maximize canvas */}
        {!fullBleed && (
          <aside className="w-[260px] flex-shrink-0 bg-sidebar flex flex-col">
            <BlueprintSidebar
              activeFilter={activeFilter}
              onFilterChange={onFilterChange}
              diagramTypeCounts={diagramTypeCounts}
              totalCount={totalCount}
              starredCount={starredCount}
              archivedCount={archivedCount}
              onNewDiagram={onNewDiagram}
            />
          </aside>
        )}

        {/* Main column */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          {/* Header */}
          <header className="flex items-center justify-between h-14 px-6 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shrink-0">
            <div className="flex items-center gap-4">
              <nav className="flex items-center border-r border-zinc-200 dark:border-zinc-700 pr-4 mr-2">
                <LaunchpadTrigger onClick={() => setLaunchpadOpen(true)} />
              </nav>

              <div className="flex items-center gap-1 text-sm">
                {crumbs.map((crumb, i) => (
                  <span key={i} className="flex items-center gap-1">
                    {i > 0 && <ChevronRight className="h-3.5 w-3.5 text-zinc-400" />}
                    {crumb.href ? (
                      <button
                        onClick={() => crumb.href && onNavigate(crumb.href!)}
                        className="text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
                      >
                        {crumb.label}
                      </button>
                    ) : (
                      <span className="text-zinc-900 dark:text-zinc-100 font-medium">{crumb.label}</span>
                    )}
                  </span>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-4">
              <OrgSwitcher
                isAuthenticated={isAuthenticated}
                reloadPath="/blueprint/"
                onAfterSwitch={fetchMe}
                fallbackActiveOrgId={user?.org_id}
              />
              <NotificationsBell inAppPrefix="/blueprint/" onNavigate={onNavigate} />
              <HelpTrigger app="blueprint" />
              <UserMenu user={user} />
            </div>
          </header>

          {/* Main content */}
          <main className="flex-1 overflow-auto bg-white dark:bg-zinc-900">
            {children}
          </main>
        </div>
      </div>
      <Launchpad isOpen={launchpadOpen} onClose={() => setLaunchpadOpen(false)} currentApp="blueprint" />
    </div>
  );
}
