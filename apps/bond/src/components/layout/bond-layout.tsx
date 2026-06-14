import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Launchpad, LaunchpadTrigger } from '@bigbluebam/ui/launchpad';
import { NotificationsBell } from '@bigbluebam/ui/notifications-bell';
import { UserMenu } from '@bigbluebam/ui/user-menu';
import { BondSidebar } from '@/components/layout/bond-sidebar';
import { OrgSwitcher } from '@/components/layout/org-switcher';
import { useAuthStore } from '@/stores/auth.store';

type ActiveRoute = { page: string; id?: string };

interface BondLayoutProps {
  children: ReactNode;
  onNavigate: (path: string) => void;
  activeRoute: ActiveRoute;
}

type Crumb = { label: string; href?: string };

function breadcrumbsFor(route: ActiveRoute): Crumb[] {
  switch (route.page) {
    case 'pipeline':
      return [{ label: 'Pipeline Board' }];
    case 'pipeline-detail':
      return [
        { label: 'Pipeline Board', href: '/' },
        { label: 'Pipeline' },
      ];
    case 'deal-detail':
      return [
        { label: 'Pipeline Board', href: '/' },
        { label: 'Deal' },
      ];
    case 'contacts':
      return [{ label: 'Contacts' }];
    case 'contact-detail':
      return [
        { label: 'Contacts', href: '/contacts' },
        { label: 'Contact' },
      ];
    case 'companies':
      return [{ label: 'Companies' }];
    case 'company-detail':
      return [
        { label: 'Companies', href: '/companies' },
        { label: 'Company' },
      ];
    case 'analytics':
      return [{ label: 'Analytics' }];
    case 'settings':
      return [{ label: 'Settings' }];
    default:
      return [];
  }
}

export function BondLayout({ children, onNavigate, activeRoute }: BondLayoutProps) {
  const user = useAuthStore((s) => s.user);
  const crumbs = breadcrumbsFor(activeRoute);
  const [launchpadOpen, setLaunchpadOpen] = useState(false);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-zinc-50 dark:bg-zinc-950">
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-[260px] flex-shrink-0 bg-sidebar flex flex-col">
          <BondSidebar onNavigate={onNavigate} activePage={activeRoute.page} />
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
              <NotificationsBell inAppPrefix="/bond/" onNavigate={onNavigate} />
              <UserMenu user={user} />
            </div>
          </header>

          {/* Main content */}
          <main className="flex-1 overflow-auto bg-white dark:bg-zinc-900">
            {children}
          </main>
        </div>
      </div>
      <Launchpad isOpen={launchpadOpen} onClose={() => setLaunchpadOpen(false)} currentApp="bond" />
    </div>
  );
}
