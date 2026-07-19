import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Launchpad, LaunchpadTrigger } from '@bigbluebam/ui/launchpad';
import { OrgSwitcher } from '@bigbluebam/ui/org-switcher';
import { NotificationsBell } from '@bigbluebam/ui/notifications-bell';
import { ImpersonationBanner } from '@bigbluebam/ui/impersonation-banner';
import { HelpTrigger } from '@bigbluebam/ui/help-center';
import { UserMenu } from '@bigbluebam/ui/user-menu';
import { BurnSidebar } from '@/components/layout/burn-sidebar';
import { useAuthStore } from '@/stores/auth.store';

export type ActiveRoute =
  | { page: 'board' }
  | { page: 'engagement-detail'; id: string; label?: string }
  | { page: 'unscoped' }
  | { page: 'variances' }
  | { page: 'gate' }
  | { page: 'cost-rates' }
  | { page: 'settings' }
  | { page: 'rules' };

interface BurnLayoutProps {
  children: ReactNode;
  onNavigate: (path: string) => void;
  activeRoute: ActiveRoute;
}

type Crumb = { label: string; href?: string };

const PAGE_LABELS: Record<ActiveRoute['page'], string> = {
  board: 'Portfolio Board',
  'engagement-detail': 'Engagement',
  unscoped: 'Unscoped Queue',
  variances: 'Variances & Change Orders',
  gate: 'Gate Console',
  'cost-rates': 'Cost Rates',
  settings: 'Settings',
  rules: 'Attribution Rules',
};

function breadcrumbsFor(route: ActiveRoute): Crumb[] {
  if (route.page === 'board') return [{ label: 'Portfolio Board' }];
  if (route.page === 'engagement-detail') {
    return [
      { label: 'Portfolio Board', href: '/' },
      { label: route.label ?? 'Engagement' },
    ];
  }
  if (route.page === 'cost-rates') {
    return [{ label: 'Settings', href: '/settings' }, { label: 'Cost Rates' }];
  }
  if (route.page === 'rules') {
    return [{ label: 'Settings', href: '/settings' }, { label: 'Attribution Rules' }];
  }
  return [{ label: PAGE_LABELS[route.page] }];
}

export function BurnLayout({ children, onNavigate, activeRoute }: BurnLayoutProps) {
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
          <BurnSidebar onNavigate={onNavigate} activeRoute={activeRoute} />
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
              <div className="hidden md:block">
                <SearchField onNavigate={onNavigate} />
              </div>
              <OrgSwitcher
                isAuthenticated={isAuthenticated}
                reloadPath="/burn/"
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
              <NotificationsBell inAppPrefix="/burn/" onNavigate={onNavigate} />
              <HelpTrigger app="burn" />
              <UserMenu user={user} />
            </div>
          </header>

          <main className="flex-1 overflow-auto bg-white dark:bg-zinc-900">{children}</main>
        </div>
      </div>
      <Launchpad isOpen={launchpadOpen} onClose={() => setLaunchpadOpen(false)} currentApp="burn" />
    </div>
  );
}

function SearchField({ onNavigate }: { onNavigate: (path: string) => void }) {
  const [q, setQ] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const term = q.trim();
        // The board is the searchable index of chains; route the query there.
        onNavigate(term ? `/?q=${encodeURIComponent(term)}` : '/');
      }}
    >
      <input
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Search engagements..."
        className="w-56 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-3 py-1.5 text-sm text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400 focus:outline-none focus:ring-1 focus:ring-primary-500"
        aria-label="Search engagements"
      />
    </form>
  );
}
