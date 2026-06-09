import { useState, useEffect, useRef, type ReactNode } from 'react';
import { Search, ChevronRight, Bell, CheckCheck, MessageCircle, AlertTriangle, X, RefreshCw } from 'lucide-react';
import { Launchpad, LaunchpadTrigger } from '@bigbluebam/ui/launchpad';
import { UserMenu } from '@bigbluebam/ui/user-menu';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Sidebar } from './sidebar';
import { CommandPalette } from '@/components/common/command-palette';
import { SuperuserContextBanner } from '@/components/superuser-context-banner';
import { OrgSwitcher } from '@/components/layout/org-switcher';
import { useAuthStore } from '@/stores/auth.store';
import { useCan } from '@bigbluebam/ui/use-can';
import { useOrgSummary } from '@/hooks/use-org-summary';
import { useProjects } from '@/hooks/use-projects';
import { useVersion } from '@/hooks/use-version';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';
import { api } from '@/lib/api';
import { formatRelativeTime } from '@/lib/utils';

interface Notification {
  id: string;
  title: string;
  body: string;
  read: boolean;
  created_at: string;
}

interface AppLayoutProps {
  children: ReactNode;
  currentProjectId?: string;
  breadcrumbs?: { label: string; href?: string }[];
  onNavigate: (path: string) => void;
  onCreateProject: () => void;
}

function UpdateBanner() {
  const { data: version } = useVersion();
  const user = useAuthStore((s) => s.user);
  const [dismissed, setDismissed] = useState(false);

  if (!user?.is_superuser || !version?.update_available || dismissed) return null;

  return (
    <div className="bg-primary-600 text-white px-4 py-2 text-sm flex items-center justify-between shrink-0">
      <div className="flex items-center gap-2">
        <RefreshCw className="h-4 w-4 animate-spin-slow" />
        <span>
          A new version of BigBlueBam is available.{' '}
          <a href="/deploy" className="underline font-medium">Update guide</a>
          {' '}or run <code className="bg-primary-700 px-1.5 py-0.5 rounded text-xs">./scripts/deploy.sh</code>
        </span>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="text-primary-200 hover:text-white transition-colors px-2"
        title="Dismiss until next login"
      >
        ✕
      </button>
    </div>
  );
}

export function AppLayout({ children, currentProjectId, breadcrumbs = [], onNavigate, onCreateProject }: AppLayoutProps) {
  const { user } = useAuthStore();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState('');
  const [showNotifications, setShowNotifications] = useState(false);
  const [launchpadOpen, setLaunchpadOpen] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);

  const { data: projectsRes } = useProjects();
  const projects = projectsRes?.data ?? [];

  // Global Cmd+K / Ctrl+K shortcut for command palette
  useKeyboardShortcuts(
    {
      'Ctrl+k': () => setShowCommandPalette(true),
      'Cmd+k': () => setShowCommandPalette(true),
    },
    true,
  );

  const { data: orgSummary } = useOrgSummary();
  const orgId = orgSummary?.id;
  const dismissKey = orgId ? `no-owner-banner-dismissed:${orgId}` : null;
  const [noOwnerDismissed, setNoOwnerDismissed] = useState(false);
  useEffect(() => {
    if (!dismissKey) {
      setNoOwnerDismissed(false);
      return;
    }
    try {
      setNoOwnerDismissed(sessionStorage.getItem(dismissKey) !== null);
    } catch {
      setNoOwnerDismissed(false);
    }
  }, [dismissKey]);

  const dismissNoOwnerBanner = () => {
    if (!dismissKey) return;
    try {
      sessionStorage.setItem(dismissKey, String(Date.now()));
    } catch {
      // ignore
    }
    setNoOwnerDismissed(true);
  };

  const showNoOwnerBanner =
    !!orgSummary && orgSummary.active_owner_count === 0 && !noOwnerDismissed;
  // Wave E.D: gate "Go to People" / People sidebar entry on the per-action
  // permission for listing org members (GET /org/members → bam.org_member.list).
  const canManageOwners = useCan('bam.org_member.list');

  const { data: notificationsRes } = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<{ data: Notification[] }>('/me/notifications'),
    refetchInterval: 30000,
  });
  const notifications = notificationsRes?.data ?? [];
  const unreadCount = notifications.filter((n) => !n.read).length;

  const markAllRead = useMutation({
    mutationFn: () => api.post('/me/notifications/mark-read'),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notifications'] });
    },
  });

  // Close notifications dropdown on outside click
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setShowNotifications(false);
      }
    };
    if (showNotifications) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showNotifications]);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-zinc-50 dark:bg-zinc-950">
      <UpdateBanner />
      <div className="flex flex-1 overflow-hidden">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[100] focus:rounded-md focus:bg-primary-600 focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-white focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-primary-400"
      >
        Skip to main content
      </a>
      <Sidebar
        currentProjectId={currentProjectId}
        onNavigate={onNavigate}
        onCreateProject={onCreateProject}
      />

      <div className="flex flex-col flex-1 overflow-hidden">
        <SuperuserContextBanner />
        {showNoOwnerBanner && (
          <div className="flex items-center gap-3 px-6 py-2.5 border-b border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300 shrink-0">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <p className="text-sm flex-1">
              {canManageOwners ? (
                <>This organization has no active owner. Any admin can promote a member to owner from the People page.</>
              ) : (
                <>This organization has no active owner. An admin can promote a member to owner from the People page.</>
              )}
            </p>
            {canManageOwners && (
              <button
                onClick={() => onNavigate('/people')}
                className="shrink-0 rounded-full border border-red-300 bg-white px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-100 dark:border-red-800 dark:bg-red-900/40 dark:text-red-200 dark:hover:bg-red-900/70 transition-colors"
              >
                Go to People
              </button>
            )}
            <button
              onClick={dismissNoOwnerBanner}
              className="shrink-0 rounded-md p-1 text-red-600 hover:bg-red-100 dark:text-red-400 dark:hover:bg-red-900/50 transition-colors"
              title="Dismiss"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
        <header className="flex items-center justify-between h-14 px-6 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shrink-0">
          <div className="flex items-center gap-4">
            {/* Launchpad app switcher */}
            <nav className="flex items-center border-r border-zinc-200 dark:border-zinc-700 pr-4 mr-2">
              <LaunchpadTrigger onClick={() => setLaunchpadOpen(true)} />
            </nav>

            {/* Breadcrumbs */}
            <div className="flex items-center gap-1 text-sm">
              {breadcrumbs.map((crumb, i) => (
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
            <OrgSwitcher />
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" aria-hidden="true" />
              <input
                type="search"
                placeholder="Search tasks..."
                aria-label="Search tasks"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-64 rounded-lg border border-zinc-200 bg-zinc-50 pl-9 pr-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500 dark:bg-zinc-800 dark:border-zinc-700 dark:text-zinc-100"
              />
            </div>

            <a
              href="/banter/"
              className="relative rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 transition-colors"
              title="Banter — unread messages"
              aria-label="Banter, view unread messages"
            >
              <MessageCircle className="h-4.5 w-4.5" aria-hidden="true" />
              <span className="absolute top-1 right-1 h-2.5 w-2.5 rounded-full bg-primary-500 ring-2 ring-white dark:ring-zinc-900" />
            </a>

            <div className="relative" ref={notifRef}>
              <button
                onClick={() => setShowNotifications((prev) => !prev)}
                className="relative rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                title="Notifications"
                aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
                aria-haspopup="menu"
                aria-expanded={showNotifications}
              >
                <Bell className="h-4.5 w-4.5" aria-hidden="true" />
                {unreadCount > 0 && (
                  <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
                    {unreadCount > 99 ? '99+' : unreadCount}
                  </span>
                )}
              </button>
              {showNotifications && (
                <div role="menu" aria-label="Notifications" className="absolute right-0 top-full mt-1 z-50 w-80 max-h-96 overflow-y-auto rounded-xl border border-zinc-200 bg-white shadow-xl dark:bg-zinc-800 dark:border-zinc-700">
                  <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100 dark:border-zinc-700">
                    <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Notifications</h3>
                    {unreadCount > 0 && (
                      <button
                        onClick={() => markAllRead.mutate()}
                        className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 transition-colors"
                      >
                        <CheckCheck className="h-3.5 w-3.5" />
                        Mark all read
                      </button>
                    )}
                  </div>
                  {notifications.length > 0 ? (
                    <div className="divide-y divide-zinc-100 dark:divide-zinc-700">
                      {notifications.map((notif) => (
                        <div
                          key={notif.id}
                          className={`px-4 py-3 text-sm ${!notif.read ? 'bg-primary-50/50 dark:bg-zinc-800/30' : ''}`}
                        >
                          <div className="flex items-start gap-2">
                            {!notif.read && (
                              <span className="mt-1.5 h-2 w-2 rounded-full bg-primary-500 shrink-0" />
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-zinc-900 dark:text-zinc-100 truncate">{notif.title}</p>
                              <p className="text-zinc-500 dark:text-zinc-400 line-clamp-2">{notif.body}</p>
                              <p className="text-xs text-zinc-400 mt-1">{formatRelativeTime(notif.created_at)}</p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="px-4 py-8 text-center text-sm text-zinc-400">
                      No notifications yet
                    </div>
                  )}
                </div>
              )}
            </div>

            <UserMenu user={user} />
          </div>
        </header>

        <main id="main-content" tabIndex={-1} className="flex-1 overflow-auto focus:outline-none">
          {children}
        </main>
      </div>
      </div>
      <Launchpad isOpen={launchpadOpen} onClose={() => setLaunchpadOpen(false)} currentApp="b3" />
      <CommandPalette
        open={showCommandPalette}
        onOpenChange={setShowCommandPalette}
        onNavigate={onNavigate}
        projects={projects}
      />
    </div>
  );
}
