import { useState, type ReactNode } from 'react';
import { ChevronRight, MessageCircle } from 'lucide-react';
import { Launchpad, LaunchpadTrigger } from '@bigbluebam/ui/launchpad';
import { OrgSwitcher } from '@bigbluebam/ui/org-switcher';
import { NotificationsBell } from '@bigbluebam/ui/notifications-bell';
import { ImpersonationBanner } from '@bigbluebam/ui/impersonation-banner';
import { HelpTrigger } from '@bigbluebam/ui/help-center';
import { UserMenu } from '@bigbluebam/ui/user-menu';
import { BasisSidebar } from '@/components/layout/basis-sidebar';
import { useAuthStore } from '@/stores/auth.store';

// The metric title (when on a detail page) rides along so the breadcrumb can
// show "Metric Catalog > <name>" the way /b3/ shows "Projects > <name>".
export type ActiveRoute = { page: 'catalog' | 'metric' | 'help'; id?: string; label?: string };

interface BasisLayoutProps {
  children: ReactNode;
  onNavigate: (path: string) => void;
  activeRoute: ActiveRoute;
}

type Crumb = { label: string; href?: string };

function breadcrumbsFor(route: ActiveRoute): Crumb[] {
  if (route.page === 'catalog') return [{ label: 'Metric Catalog' }];
  return [{ label: 'Metric Catalog', href: '/' }, { label: route.label ?? 'Metric' }];
}

export function BasisLayout({ children, onNavigate, activeRoute }: BasisLayoutProps) {
  const user = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const fetchMe = useAuthStore((s) => s.fetchMe);
  const crumbs = breadcrumbsFor(activeRoute);
  const [launchpadOpen, setLaunchpadOpen] = useState(false);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-zinc-50 dark:bg-zinc-950">
      <ImpersonationBanner />
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-[260px] flex-shrink-0 bg-sidebar flex flex-col">
          <BasisSidebar onNavigate={onNavigate} activeRoute={activeRoute} />
        </aside>

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
                        onClick={() => crumb.href && onNavigate(crumb.href)}
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
                reloadPath="/basis/"
                onAfterSwitch={fetchMe}
                fallbackActiveOrgId={user?.org_id}
              />
              <a
                href="/banter/"
                className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 transition-colors"
                title="Banter"
                aria-label="Banter"
              >
                <MessageCircle className="h-4.5 w-4.5" aria-hidden="true" />
              </a>
              <NotificationsBell inAppPrefix="/basis/" onNavigate={onNavigate} />
              <HelpTrigger app="basis" />
              <UserMenu user={user} />
            </div>
          </header>

          <main className="flex-1 overflow-auto bg-white dark:bg-zinc-900">{children}</main>
        </div>
      </div>
      <Launchpad isOpen={launchpadOpen} onClose={() => setLaunchpadOpen(false)} currentApp="basis" />
    </div>
  );
}
