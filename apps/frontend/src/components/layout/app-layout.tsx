import { useState, useEffect, useRef, useMemo, type ReactNode } from 'react';
import {
  Search,
  ChevronRight,
  Bell,
  CheckCheck,
  MessageCircle,
  AlertTriangle,
  X,
  RefreshCw,
  CheckSquare,
  Hash,
  UserPlus,
  Hand,
} from 'lucide-react';
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

// A persistent notification row as returned by GET /me/notifications.
// NOTE: the API returns `is_read`, NOT `read` — the previous interface used
// `read`, so `!n.read` treated every row as unread and the badge was wrong.
interface Notification {
  id: string;
  type: string;
  category: string;
  source_app: string;
  title: string;
  body: string;
  deep_link: string | null;
  task_id: string | null;
  created_at: string;
  is_read: boolean;
}

// A single Banter channel with an unread count, as returned by
// GET /banter/api/v1/channels. We only consume the fields we render.
interface BanterChannel {
  id: string;
  slug: string;
  name: string;
  type: string;
  unread_count: number;
  last_message_at: string | null;
  dm_other_participant: { id: string; display_name: string } | null;
}

// The unified queue item. Every source (persistent notification or Banter
// unread channel) is normalized into this shape so the dropdown renders one
// recency-sorted list. `source` discriminates click behavior.
interface QueueItem {
  key: string;
  kind: 'notification' | 'banter-channel';
  // Drives the lucide icon + click handling.
  category: 'assignment' | 'invite' | 'knock' | 'dm' | 'channel' | 'other';
  title: string;
  body: string;
  // ISO timestamp used for recency sort + relative-time display.
  timestamp: string;
  // Present only for kind === 'notification'.
  notification?: Notification;
  // Present only for kind === 'banter-channel'.
  channel?: BanterChannel;
}

interface AppLayoutProps {
  children: ReactNode;
  currentProjectId?: string;
  breadcrumbs?: { label: string; href?: string }[];
  onNavigate: (path: string) => void;
  onCreateProject: () => void;
}

// Map a queue item category to its lucide icon.
function queueItemIcon(category: QueueItem['category']) {
  switch (category) {
    case 'assignment':
      return CheckSquare;
    case 'dm':
      return MessageCircle;
    case 'channel':
      return Hash;
    case 'invite':
      return UserPlus;
    case 'knock':
      return Hand;
    default:
      return Bell;
  }
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

  const activeOrgId = user?.active_org_id ?? user?.org_id;

  // Source A — persistent notification rows. We only want the unread ones in
  // the bell, and we trust the server's `meta.unread_count` for the badge
  // rather than counting client-side rows (which would only reflect the
  // current page). Today these are Bam task assignments; Bureau invites/knocks
  // (source_app:'bureau', category:'invite'|'knock') will arrive here later
  // and flow through the same queue without further wiring.
  const { data: notificationsRes } = useQuery({
    queryKey: ['notifications'],
    queryFn: () =>
      api.get<{ data: Notification[]; meta: { unread_count: number } }>(
        '/me/notifications',
        { unread_only: 'true' },
      ),
    refetchInterval: 30000,
  });
  const notifications = notificationsRes?.data ?? [];
  const notificationUnreadCount = notificationsRes?.meta?.unread_count ?? 0;

  // Source B — Banter unread channels. We fetch /banter/api/v1/channels (not
  // /me/unread) because the queue needs each channel's name/slug/type to build
  // a readable item, and /me/unread only returns { channel_id, unread_count }.
  // The channels list returns the full channel object plus per-channel
  // unread_count, so we filter to unread_count > 0 here. X-Org-Id pins the
  // request to the org this Bam tab is viewing (defense-in-depth; the API also
  // falls back to the session's active org). Errors are swallowed — a missing
  // Banter must not break Bam's chrome. Query key stays 'banter-unread-total'
  // so existing invalidations keep working.
  const { data: banterChannels } = useQuery({
    queryKey: ['banter-unread-total'],
    queryFn: async () => {
      const headers: Record<string, string> = {};
      if (activeOrgId) headers['X-Org-Id'] = activeOrgId;
      const res = await fetch('/banter/api/v1/channels', {
        credentials: 'include',
        headers,
      });
      if (!res.ok) return [] as BanterChannel[];
      const body = (await res.json()) as { data?: BanterChannel[] };
      return (body.data ?? []).filter((c) => (c.unread_count ?? 0) > 0);
    },
    refetchInterval: 30000,
    retry: false,
  });
  const unreadChannels = useMemo(() => banterChannels ?? [], [banterChannels]);
  const banterUnreadTotal = useMemo(
    () => unreadChannels.reduce((sum, c) => sum + (c.unread_count ?? 0), 0),
    [unreadChannels],
  );

  // Badge = unread persistent notifications + total unread Banter messages.
  const unreadCount = notificationUnreadCount + banterUnreadTotal;

  // Merge both sources into one recency-sorted queue.
  const queueItems = useMemo<QueueItem[]>(() => {
    const items: QueueItem[] = [];

    for (const n of notifications) {
      const category: QueueItem['category'] =
        n.category === 'assignment'
          ? 'assignment'
          : n.category === 'invite'
            ? 'invite'
            : n.category === 'knock'
              ? 'knock'
              : 'other';
      items.push({
        key: `notif:${n.id}`,
        kind: 'notification',
        category,
        title: n.title,
        body: n.body,
        timestamp: n.created_at,
        notification: n,
      });
    }

    for (const c of unreadChannels) {
      const isDm = c.type === 'dm';
      items.push({
        key: `banter:${c.id}`,
        kind: 'banter-channel',
        category: isDm ? 'dm' : 'channel',
        title: isDm
          ? (c.dm_other_participant?.display_name ?? 'Direct message')
          : `#${c.name}`,
        body: `${c.unread_count} new message${c.unread_count === 1 ? '' : 's'}`,
        timestamp: c.last_message_at ?? new Date(0).toISOString(),
        channel: c,
      });
    }

    return items.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
  }, [notifications, unreadChannels]);

  const refetchQueue = () => {
    queryClient.invalidateQueries({ queryKey: ['notifications'] });
    queryClient.invalidateQueries({ queryKey: ['banter-unread-total'] });
  };

  // Cross-app navigation helper. In-app /b3/... paths go through onNavigate
  // (client-side routing); absolute cross-app paths (/banter, /bureau, ...)
  // are a hard navigation via window.location.
  const navigateTo = (path: string) => {
    if (path.startsWith('/b3/')) {
      onNavigate(path.slice('/b3'.length) || '/');
    } else {
      window.location.href = path;
    }
  };

  // POST a Banter mark-read for one channel. The endpoint requires the latest
  // message_id, which the channels list doesn't expose, so we fetch the
  // newest message (limit=1, default newest-first) to get it, then mark read.
  const markBanterChannelRead = async (channel: BanterChannel) => {
    const headers: Record<string, string> = {};
    if (activeOrgId) headers['X-Org-Id'] = activeOrgId;
    const msgRes = await fetch(
      `/banter/api/v1/channels/${channel.id}/messages?limit=1`,
      { credentials: 'include', headers },
    );
    if (!msgRes.ok) return;
    const msgBody = (await msgRes.json()) as { data?: { id: string }[] };
    const latestId = msgBody.data?.[0]?.id;
    if (!latestId) return;
    await fetch(`/banter/api/v1/channels/${channel.id}/mark-read`, {
      method: 'POST',
      credentials: 'include',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message_id: latestId }),
    });
  };

  // Click a queue item.
  const handleItemClick = async (item: QueueItem) => {
    setShowNotifications(false);
    if (item.kind === 'notification' && item.notification) {
      const n = item.notification;
      // Always acknowledge (mark read) first.
      await api.post(`/me/notifications/${n.id}/read`).catch(() => {});
      // Invite/knock: acknowledge only, no navigation — it just leaves the queue.
      if (n.category !== 'invite' && n.category !== 'knock') {
        const target = n.deep_link ?? (n.task_id ? `/b3/tasks/${n.task_id}` : null);
        if (target) navigateTo(target);
      }
      refetchQueue();
    } else if (item.kind === 'banter-channel' && item.channel) {
      // Opening the channel marks it read in Banter, so it drops off the next
      // poll — no explicit mark-read needed on the click path.
      window.location.href = `/banter/channels/${item.channel.slug}`;
    }
  };

  // Clear All: mark every persistent notification read AND mark each unread
  // Banter channel read, then refetch so the queue empties.
  const clearAll = useMutation({
    mutationFn: async () => {
      await api.post('/me/notifications/mark-all-read').catch(() => {});
      // A handful of channels at most — mark each read best-effort.
      await Promise.all(
        unreadChannels.map((c) => markBanterChannelRead(c).catch(() => {})),
      );
    },
    onSuccess: () => {
      refetchQueue();
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
                    {queueItems.length > 0 && (
                      <button
                        type="button"
                        onClick={() => clearAll.mutate()}
                        disabled={clearAll.isPending}
                        className="flex items-center gap-1 text-xs text-primary-600 hover:text-primary-700 transition-colors disabled:opacity-50"
                      >
                        <CheckCheck className="h-3.5 w-3.5" />
                        Clear all
                      </button>
                    )}
                  </div>
                  {queueItems.length > 0 ? (
                    <div className="divide-y divide-zinc-100 dark:divide-zinc-700">
                      {queueItems.map((item) => {
                        const Icon = queueItemIcon(item.category);
                        return (
                          <button
                            key={item.key}
                            type="button"
                            role="menuitem"
                            onClick={() => handleItemClick(item)}
                            className="w-full text-left px-4 py-3 text-sm bg-primary-50/50 dark:bg-zinc-800/30 hover:bg-primary-100/60 dark:hover:bg-zinc-700/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
                          >
                            <div className="flex items-start gap-2">
                              <Icon className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500" aria-hidden="true" />
                              <div className="flex-1 min-w-0">
                                <p className="font-medium text-zinc-900 dark:text-zinc-100 truncate">{item.title}</p>
                                <p className="text-zinc-500 dark:text-zinc-400 line-clamp-2">{item.body}</p>
                                <p className="text-xs text-zinc-400 mt-1">{formatRelativeTime(item.timestamp)}</p>
                              </div>
                              <span className="mt-1.5 h-2 w-2 rounded-full bg-primary-500 shrink-0" aria-label="Unread" />
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="px-4 py-8 text-center text-sm text-zinc-400">
                      You're all caught up
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
