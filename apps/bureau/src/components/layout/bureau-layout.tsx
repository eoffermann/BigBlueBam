import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Launchpad, LaunchpadTrigger } from '@bigbluebam/ui/launchpad';
import { OrgSwitcher } from '@bigbluebam/ui/org-switcher';
import { NotificationsBell } from '@bigbluebam/ui/notifications-bell';
import { UserMenu } from '@bigbluebam/ui/user-menu';
import { BureauSidebar } from '@/components/layout/bureau-sidebar';
import { useAuthStore } from '@/stores/auth.store';

type ActiveRoute = { page: string; id?: string };

interface BureauLayoutProps {
  children: ReactNode;
  onNavigate: (path: string) => void;
  activeRoute: ActiveRoute;
  /** Floor or admin/floor id when present — drives sidebar highlight. */
  activeFloorId: string | null;
  /** Optional floor name for the breadcrumb on /floors/:id pages. */
  activeFloorName?: string;
  /** When true the sidebar collapses to maximize canvas space. */
  fullBleed?: boolean;
}

type Crumb = { label: string; href?: string };

function breadcrumbsFor(
  route: ActiveRoute,
  activeFloorName: string | undefined,
): Crumb[] {
  switch (route.page) {
    case 'floor-list':
      return [{ label: 'Floors' }];
    case 'floor':
      return [
        { label: 'Floors', href: '/' },
        { label: activeFloorName ?? 'Floor' },
      ];
    case 'admin-floor':
      return [
        { label: 'Admin', href: '/admin/floors' },
        { label: activeFloorName ?? 'Floor' },
      ];
    case 'admin-floor-list':
      return [{ label: 'Admin' }, { label: 'Floors' }];
    case 'admin-offices':
      return [{ label: 'Admin' }, { label: 'Offices' }];
    default:
      return [];
  }
}

export function BureauLayout({
  children,
  onNavigate,
  activeRoute,
  activeFloorId,
  activeFloorName,
  fullBleed,
}: BureauLayoutProps) {
  const user = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const fetchMe = useAuthStore((s) => s.fetchMe);
  const crumbs = breadcrumbsFor(activeRoute, activeFloorName);
  const [launchpadOpen, setLaunchpadOpen] = useState(false);

  const isOnAdmin =
    activeRoute.page === 'admin-floor' ||
    activeRoute.page === 'admin-floor-list' ||
    activeRoute.page === 'admin-offices';
  const adminSection: 'floors' | 'offices' | null =
    activeRoute.page === 'admin-offices'
      ? 'offices'
      : activeRoute.page === 'admin-floor' || activeRoute.page === 'admin-floor-list'
      ? 'floors'
      : null;

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-zinc-50 dark:bg-zinc-950">
      <div className="flex flex-1 overflow-hidden">
        {!fullBleed && (
          <aside className="w-[260px] flex-shrink-0 bg-sidebar flex flex-col">
            <BureauSidebar
              onNavigate={onNavigate}
              activeFloorId={activeFloorId}
              isOnAdmin={isOnAdmin}
              adminSection={adminSection}
            />
          </aside>
        )}

        <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
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
                reloadPath="/bureau/"
                onAfterSwitch={fetchMe}
                fallbackActiveOrgId={user?.org_id}
              />
              <NotificationsBell inAppPrefix="/bureau/" onNavigate={onNavigate} />
              <UserMenu user={user} />
            </div>
          </header>

          <main className="flex-1 overflow-auto bg-white dark:bg-zinc-900">
            {children}
          </main>
        </div>
      </div>
      <Launchpad isOpen={launchpadOpen} onClose={() => setLaunchpadOpen(false)} currentApp="bureau" />
    </div>
  );
}
