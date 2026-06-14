import { useState, type ReactNode } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { Launchpad, LaunchpadTrigger } from '@bigbluebam/ui/launchpad';
import { NotificationsBell } from '@bigbluebam/ui/notifications-bell';
import { UserMenu } from '@bigbluebam/ui/user-menu';
import { BriefSidebar } from '@/components/layout/brief-sidebar';
import { OrgSwitcher } from '@/components/layout/org-switcher';
import { useAuthStore } from '@/stores/auth.store';
import { useProjectStore } from '@/stores/project.store';
import { useProjectName } from '@/hooks/use-projects';

type ActiveRoute = { page: string; idOrSlug?: string; folderId?: string | null };

interface BriefLayoutProps {
  children: ReactNode;
  onNavigate: (path: string) => void;
  activeRoute: ActiveRoute;
}

type Crumb = { label: string; href?: string };

function breadcrumbsFor(route: ActiveRoute): Crumb[] {
  switch (route.page) {
    case 'home':
      return [{ label: 'Home' }];
    case 'documents':
      return [{ label: 'Documents' }];
    case 'search':
      return [{ label: 'Search' }];
    case 'starred':
      return [{ label: 'Starred' }];
    case 'templates':
      return [{ label: 'Templates' }];
    case 'detail':
      return [
        { label: 'Documents', href: '/documents' },
        { label: route.idOrSlug ?? 'Document' },
      ];
    case 'new':
      return [
        { label: 'Documents', href: '/documents' },
        { label: 'New Document' },
      ];
    case 'edit':
      return [
        { label: 'Documents', href: '/documents' },
        { label: route.idOrSlug ?? 'Document', href: `/documents/${route.idOrSlug}` },
        { label: 'Edit' },
      ];
    default:
      return [];
  }
}

export function BriefLayout({ children, onNavigate, activeRoute }: BriefLayoutProps) {
  const user = useAuthStore((s) => s.user);
  const activeProjectId = useProjectStore((s) => s.activeProjectId);
  const activeProjectName = useProjectName(activeProjectId);

  const crumbs = breadcrumbsFor(activeRoute);
  const [launchpadOpen, setLaunchpadOpen] = useState(false);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-zinc-50 dark:bg-zinc-950">
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-[260px] flex-shrink-0 bg-sidebar flex flex-col">
          <BriefSidebar
            onNavigate={onNavigate}
            activePage={activeRoute.page}
            activeFolderId={activeRoute.folderId ?? null}
          />
        </aside>

        {/* Main column */}
        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
          {/* Header */}
          <header className="flex items-center justify-between h-14 px-6 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shrink-0">
            <div className="flex items-center gap-4">
              {/* Launchpad app switcher */}
              <nav className="flex items-center border-r border-zinc-200 dark:border-zinc-700 pr-4 mr-2">
                <LaunchpadTrigger onClick={() => setLaunchpadOpen(true)} />
              </nav>

              {/* Breadcrumbs */}
              <div className="flex items-center gap-1 text-sm">
                {activeProjectName && (
                  <>
                    <span className="text-zinc-500 dark:text-zinc-400">{activeProjectName}</span>
                    {crumbs.length > 0 && <ChevronRight className="h-3.5 w-3.5 text-zinc-400" />}
                  </>
                )}
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
              <OrgSwitcher />
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
                <input
                  type="text"
                  placeholder="Search documents..."
                  className="w-64 rounded-lg border border-zinc-200 bg-zinc-50 pl-9 pr-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100"
                  onFocus={() => onNavigate('/search')}
                />
              </div>

              <NotificationsBell inAppPrefix="/brief/" onNavigate={onNavigate} />

              <UserMenu user={user} />
            </div>
          </header>

          {/* Main content */}
          <main className="flex-1 overflow-auto bg-white dark:bg-zinc-900">
            {children}
          </main>
        </div>
      </div>
      <Launchpad isOpen={launchpadOpen} onClose={() => setLaunchpadOpen(false)} currentApp="brief" />
    </div>
  );
}
