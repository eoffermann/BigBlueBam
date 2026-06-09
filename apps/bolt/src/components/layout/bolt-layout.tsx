import { useState, type ReactNode } from 'react';
import { ChevronRight, Bell } from 'lucide-react';
import { Launchpad, LaunchpadTrigger } from '@bigbluebam/ui/launchpad';
import { UserMenu } from '@bigbluebam/ui/user-menu';
import { BoltSidebar } from '@/components/layout/bolt-sidebar';
import { OrgSwitcher } from '@/components/layout/org-switcher';
import { useAuthStore } from '@/stores/auth.store';
import { useProjectStore } from '@/stores/project.store';
import { useProjectName } from '@/hooks/use-projects';

type ActiveRoute = { page: string; id?: string };

interface BoltLayoutProps {
  children: ReactNode;
  onNavigate: (path: string) => void;
  activeRoute: ActiveRoute;
}

type Crumb = { label: string; href?: string };

function breadcrumbsFor(route: ActiveRoute): Crumb[] {
  switch (route.page) {
    case 'home':
      return [{ label: 'Automations' }];
    case 'executions':
      return [{ label: 'Executions' }];
    case 'templates':
      return [{ label: 'Templates' }];
    case 'new':
      return [
        { label: 'Automations', href: '/' },
        { label: 'New Automation' },
      ];
    case 'editor':
      return [
        { label: 'Automations', href: '/' },
        { label: route.id ?? 'Automation' },
      ];
    case 'automation-executions':
      return [
        { label: 'Automations', href: '/' },
        { label: route.id ?? 'Automation', href: `/automations/${route.id}` },
        { label: 'Executions' },
      ];
    case 'execution-detail':
      return [
        { label: 'Executions', href: '/executions' },
        { label: route.id ?? 'Execution' },
      ];
    default:
      return [];
  }
}

export function BoltLayout({ children, onNavigate, activeRoute }: BoltLayoutProps) {
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
          <BoltSidebar onNavigate={onNavigate} activePage={activeRoute.page} />
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

              <button
                className="relative rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 transition-colors"
                title="Notifications"
              >
                <Bell className="h-4.5 w-4.5" />
              </button>

              <UserMenu user={user} />
            </div>
          </header>

          {/* Main content */}
          <main className="flex-1 overflow-auto bg-white dark:bg-zinc-900">
            {children}
          </main>
        </div>
      </div>
      <Launchpad isOpen={launchpadOpen} onClose={() => setLaunchpadOpen(false)} currentApp="bolt" />
    </div>
  );
}
