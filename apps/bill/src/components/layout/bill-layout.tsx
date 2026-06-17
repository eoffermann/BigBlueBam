import { useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { Launchpad, LaunchpadTrigger } from '@bigbluebam/ui/launchpad';
import { OrgSwitcher } from '@bigbluebam/ui/org-switcher';
import { NotificationsBell } from '@bigbluebam/ui/notifications-bell';
import { HelpTrigger } from '@bigbluebam/ui/help-center';
import { UserMenu } from '@bigbluebam/ui/user-menu';
import { BillSidebar } from '@/components/layout/bill-sidebar';
import { useAuthStore } from '@/stores/auth.store';

type ActiveRoute = { page: string; id?: string };

interface BillLayoutProps {
  children: ReactNode;
  onNavigate: (path: string) => void;
  activeRoute: ActiveRoute;
}

type Crumb = { label: string; href?: string };

function breadcrumbsFor(route: ActiveRoute): Crumb[] {
  switch (route.page) {
    case 'dashboard':
      return [{ label: 'Dashboard' }];
    case 'invoices':
      return [{ label: 'Invoices' }];
    case 'invoice-new':
      return [{ label: 'Invoices', href: '/invoices' }, { label: 'New Invoice' }];
    case 'invoice-from-time':
      return [{ label: 'Invoices', href: '/invoices' }, { label: 'From Time Entries' }];
    case 'invoice-detail':
      return [{ label: 'Invoices', href: '/invoices' }, { label: 'Invoice Detail' }];
    case 'invoice-edit':
      return [{ label: 'Invoices', href: '/invoices' }, { label: 'Edit Invoice' }];
    case 'recurring':
      return [{ label: 'Recurring' }];
    case 'clients':
      return [{ label: 'Clients' }];
    case 'client-detail':
      return [{ label: 'Clients', href: '/clients' }, { label: 'Client Detail' }];
    case 'expenses':
      return [{ label: 'Expenses' }];
    case 'expense-new':
      return [{ label: 'Expenses', href: '/expenses' }, { label: 'New Expense' }];
    case 'rates':
      return [{ label: 'Billing Rates' }];
    case 'reports':
      return [{ label: 'Financial Reports' }];
    case 'settings':
      return [{ label: 'Billing Settings' }];
    default:
      return [];
  }
}

export function BillLayout({ children, onNavigate, activeRoute }: BillLayoutProps) {
  const user = useAuthStore((s) => s.user);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const fetchMe = useAuthStore((s) => s.fetchMe);
  const crumbs = breadcrumbsFor(activeRoute);
  const [launchpadOpen, setLaunchpadOpen] = useState(false);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-zinc-50 dark:bg-zinc-950">
      <div className="flex flex-1 overflow-hidden">
        {/* Sidebar */}
        <aside className="w-[260px] flex-shrink-0 bg-sidebar flex flex-col">
          <BillSidebar onNavigate={onNavigate} activePage={activeRoute.page} />
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

            <div className="flex items-center gap-4">
              <OrgSwitcher
                isAuthenticated={isAuthenticated}
                reloadPath="/bill/"
                onAfterSwitch={fetchMe}
                fallbackActiveOrgId={user?.org_id}
              />
              <NotificationsBell inAppPrefix="/bill/" onNavigate={onNavigate} />
              <HelpTrigger app="bill" />
              <UserMenu user={user} />
            </div>
          </header>

          {/* Main content */}
          <main className="flex-1 overflow-auto bg-white dark:bg-zinc-900">
            {children}
          </main>
        </div>
      </div>
      <Launchpad isOpen={launchpadOpen} onClose={() => setLaunchpadOpen(false)} currentApp="bill" />
    </div>
  );
}
