import { useState, useEffect, type ReactNode } from 'react';
import {
  Search,
  ChevronRight,
  MessageCircle,
  AlertTriangle,
  X,
  RefreshCw,
} from 'lucide-react';
import { Launchpad, LaunchpadTrigger } from '@bigbluebam/ui/launchpad';
import { NotificationsBell } from '@bigbluebam/ui/notifications-bell';
import { HelpTrigger } from '@bigbluebam/ui/help-center';
import { UserMenu } from '@bigbluebam/ui/user-menu';
import { Sidebar } from './sidebar';
import { CommandPalette } from '@/components/common/command-palette';
import { SuperuserContextBanner } from '@/components/superuser-context-banner';
import { ImpersonationBanner } from '@/components/superuser/impersonation-banner';
import { OrgSwitcher } from '@/components/layout/org-switcher';
import { useAuthStore } from '@/stores/auth.store';
import { useCan } from '@bigbluebam/ui/use-can';
import { useOrgSummary } from '@/hooks/use-org-summary';
import { useProjects } from '@/hooks/use-projects';
import { useVersion } from '@/hooks/use-version';
import { useKeyboardShortcuts } from '@/hooks/use-keyboard-shortcuts';

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
  const [searchQuery, setSearchQuery] = useState('');
  const [launchpadOpen, setLaunchpadOpen] = useState(false);
  const [showCommandPalette, setShowCommandPalette] = useState(false);

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

  // People Manager v2 (M2): gate the command-palette entry. Mirror the plan
  // §5 "can the caller manage anyone?" gate. `org_memberships` is not on the
  // frontend User payload today, so the role-based clause folds into the
  // `useCan` clause (members carry bam.org_member.list); SuperUsers always
  // pass.
  const canManagePeople =
    user?.is_superuser === true ||
    (
      user as { org_memberships?: { role: string }[] } | null | undefined
    )?.org_memberships?.some((m) => ['admin', 'owner'].includes(m.role)) === true ||
    canManageOwners;

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-zinc-50 dark:bg-zinc-950">
      <ImpersonationBanner />
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

            {/* Plain Banter launcher. Unread now lives in the bell queue, so
                this icon no longer carries an unread dot/role. */}
            <a
              href="/banter/"
              className="rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 transition-colors"
              title="Banter"
              aria-label="Banter"
            >
              <MessageCircle className="h-4.5 w-4.5" aria-hidden="true" />
            </a>

            <NotificationsBell inAppPrefix="/b3/" onNavigate={onNavigate} />

            <HelpTrigger app="bam" />

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
        canManagePeople={canManagePeople}
      />
    </div>
  );
}
