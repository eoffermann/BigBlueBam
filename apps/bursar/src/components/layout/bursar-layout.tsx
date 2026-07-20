import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Launchpad, LaunchpadTrigger } from '@bigbluebam/ui/launchpad';
import { OrgSwitcher } from '@bigbluebam/ui/org-switcher';
import { NotificationsBell } from '@bigbluebam/ui/notifications-bell';
import { ImpersonationBanner } from '@bigbluebam/ui/impersonation-banner';
import { HelpTrigger } from '@bigbluebam/ui/help-center';
import { UserMenu } from '@bigbluebam/ui/user-menu';
import { BursarSidebar } from '@/components/layout/bursar-sidebar';
import { useAuthStore } from '@/stores/auth.store';

export type ActiveRoute =
  | { page: 'board' }
  | { page: 'requests' }
  | { page: 'request-scope'; id: string; label?: string }
  | { page: 'request-level'; id: string; label?: string }
  | { page: 'request-diff'; id: string; label?: string }
  | { page: 'vendor-detail'; id: string; label?: string }
  | { page: 'mismatches' }
  | { page: 'renewals' }
  | { page: 'review' }
  | { page: 'settings' };

interface BursarLayoutProps {
  children: ReactNode;
  onNavigate: (path: string) => void;
  activeRoute: ActiveRoute;
}

type Crumb = { label: string; href?: string };

function breadcrumbsFor(route: ActiveRoute): Crumb[] {
  switch (route.page) {
    case 'board':
      return [{ label: 'Vendor Portfolio' }];
    case 'requests':
      return [{ label: 'Requests' }];
    case 'request-scope':
      return [{ label: 'Requests', href: '/requests' }, { label: route.label ?? 'Scope Tree' }];
    case 'request-level':
      return [
        { label: 'Requests', href: '/requests' },
        { label: route.label ?? 'Request', href: `/requests/${route.id}` },
        { label: 'Leveling Matrix' },
      ];
    case 'request-diff':
      return [
        { label: 'Requests', href: '/requests' },
        { label: route.label ?? 'Request', href: `/requests/${route.id}` },
        { label: 'Exclusion Diff' },
      ];
    case 'vendor-detail':
      return [{ label: 'Vendor Portfolio', href: '/' }, { label: route.label ?? 'Vendor' }];
    case 'mismatches':
      return [{ label: 'Mismatch Inbox' }];
    case 'renewals':
      return [{ label: 'Renewal Radar' }];
    case 'review':
      return [{ label: 'Review Queue' }];
    case 'settings':
      return [{ label: 'Settings' }];
    default:
      return [{ label: 'Bursar' }];
  }
}

export function BursarLayout({ children, onNavigate, activeRoute }: BursarLayoutProps) {
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
          <BursarSidebar onNavigate={onNavigate} activeRoute={activeRoute} />
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

            <div className="flex items-center gap-3">
              <OrgSwitcher
                isAuthenticated={isAuthenticated}
                reloadPath="/bursar/"
                onAfterSwitch={fetchMe}
                fallbackActiveOrgId={user?.org_id}
              />
              <a
                href="/banter/"
                title="Open Banter"
                className="text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200 text-sm font-medium"
              >
                Banter
              </a>
              <NotificationsBell inAppPrefix="/bursar/" onNavigate={onNavigate} />
              <HelpTrigger app="bursar" />
              <UserMenu user={user} />
            </div>
          </header>

          <main className="flex-1 overflow-auto bg-white dark:bg-zinc-900">{children}</main>
        </div>
      </div>
      <Launchpad isOpen={launchpadOpen} onClose={() => setLaunchpadOpen(false)} currentApp="bursar" />
    </div>
  );
}
