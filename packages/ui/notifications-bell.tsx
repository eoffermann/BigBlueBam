/**
 * Canonical NotificationsBell component shared across all BigBlueBam apps.
 *
 * Every frontend app imports this file via a Vite alias:
 *   '@bigbluebam/ui/notifications-bell' -> '<root>/packages/ui/notifications-bell.tsx'
 *
 * It folds together two unread sources into one recency-sorted queue:
 *
 *  - Source A — persistent notification rows from the Bam auth API
 *    (GET /b3/api/me/notifications?unread_only=true). The API returns
 *    `is_read` (NOT `read`), and the badge count comes from
 *    `meta.unread_count`, never a client-side `!is_read` tally.
 *  - Source B — Banter unread channels (GET /banter/api/v1/channels,
 *    filtered to unread_count > 0). One synthetic queue item per channel.
 *
 * The badge = persistent unread_count + total unread Banter messages.
 *
 * Clicking an item:
 *  - task/assignment notification → mark read, then navigate (deep_link,
 *    else /b3/tasks/<task_id>) honoring inAppPrefix/onNavigate.
 *  - invite/knock notification → mark read ONLY (acknowledge), no nav.
 *  - Banter channel → hard-navigate to /banter/channels/<slug>.
 *
 * Realtime: a WebSocket to /b3/ws subscribes to the current user's personal
 * room `user:<userId>`. Any `{ type: 'notification' }` event invalidates both
 * queries so the bell updates instantly. The protocol (subscribe message,
 * ping keepalive, exponential-backoff reconnect) mirrors
 * apps/frontend/src/lib/websocket.ts exactly. A 30s poll remains as a
 * fallback, so the bell still works in apps where /b3/ws is unreachable.
 *
 * Identity (userId + orgId) is fetched INSIDE the component from
 * GET /b3/api/auth/me so the public props can stay minimal and every host
 * app can render <NotificationsBell inAppPrefix="..." onNavigate={...} />.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bell, CheckCheck, CheckSquare, Hash, Hand, MessageCircle, UserPlus } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

// ── Types ────────────────────────────────────────────────────

/**
 * A persistent notification row as returned by GET /me/notifications.
 * NOTE: the API returns `is_read`, NOT `read`. The legacy interface used
 * `read`, so `filter(n => !n.read)` treated every row as unread and the
 * badge was always wrong. The richer fields (category/source_app/type/
 * deep_link/task_id) are optional because older rows / satellite apps may
 * not populate them.
 */
interface Notification {
  id: string;
  title: string;
  body: string;
  is_read: boolean;
  created_at: string;
  category?: string | null;
  source_app?: string | null;
  type?: string | null;
  deep_link?: string | null;
  task_id?: string | null;
}

/**
 * A single Banter channel with an unread count, as returned by
 * GET /banter/api/v1/channels. We only consume the fields we render.
 */
interface BanterChannel {
  id: string;
  slug: string;
  name: string;
  type: string;
  unread_count: number;
  last_message_at: string | null;
  dm_other_participant: { id: string; display_name: string } | null;
}

/** The current user's identity, from GET /b3/api/auth/me. */
interface MeIdentity {
  id: string;
  orgId: string | null;
}

/**
 * The unified queue item. Every source (persistent notification or Banter
 * unread channel) is normalized into this shape so the dropdown renders one
 * recency-sorted list. `kind` discriminates click behavior.
 */
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

export interface NotificationsBellProps {
  /**
   * When a notification's `deep_link` starts with this prefix (e.g.
   * '/blast/'), we strip the prefix and call `onNavigate` with the
   * remaining SPA path. Otherwise we navigate cross-app via
   * window.location.href.
   */
  inAppPrefix: string;
  /** In-app navigation handler for the host SPA's router. */
  onNavigate?: (path: string) => void;
}

// ── Bam API helpers ──────────────────────────────────────────

function joinUrl(path: string): string {
  return `/b3/api${path}`;
}

async function bbbGet<T>(path: string): Promise<T> {
  const res = await fetch(joinUrl(path), { credentials: 'include' });
  if (!res.ok) throw new Error(`Bam API error: ${res.status}`);
  return res.json();
}

async function bbbPost<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(joinUrl(path), {
    method: 'POST',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    credentials: 'include',
    body: body ? JSON.stringify(body) : undefined,
    // keepalive lets the request finish even if the click immediately
    // triggers a (cross-app) navigation that unloads the page. Without it,
    // clicking a notification that deep-links elsewhere aborts the in-flight
    // mark-read POST, so the notification never actually clears — which is
    // exactly why "Clear all" (no navigation) worked but single clicks didn't.
    keepalive: true,
  });
  if (!res.ok) throw new Error(`Bam API error: ${res.status}`);
  return res.json();
}

/** Best-effort relative time formatter that does not pull in date-fns. */
function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const diffMs = Date.now() - then;
  const sec = Math.round(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.round(mo / 12);
  return `${yr}y ago`;
}

/** Map a queue item category to its lucide icon. */
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

// ── Realtime: mirror apps/frontend/src/lib/websocket.ts ───────
//
// Same wire protocol the Bam SPA uses for /b3/ws:
//   - connect to `${ws|wss}://<host>/b3/ws` (cookie auth on upgrade)
//   - on open: send { type: 'subscribe', room: 'user:<userId>' }
//     (the server also auto-subscribes the personal room, but we send it
//     explicitly so we mirror the SPA and survive any server-side change)
//   - keepalive: { type: 'ping' } every 30s
//   - reconnect: exponential backoff 1s → 30s
//   - ignore internal frames: connected / subscribed / unsubscribed / pong
// We do NOT depend on the SPA's singleton `ws` manager (satellite apps don't
// ship it), so this is a small self-contained connection scoped to the bell.

const WS_MIN_RECONNECT_DELAY = 1000;
const WS_MAX_RECONNECT_DELAY = 30000;
const WS_RECONNECT_MULTIPLIER = 2;

interface NotificationSocket {
  close: () => void;
}

/**
 * Open a notification-only WebSocket for `userId`. Calls `onNotification`
 * whenever a `{ type: 'notification' }` frame arrives. Fully self-healing
 * (reconnects with backoff) and never throws — if /b3/ws can't be reached
 * (e.g. a satellite app whose nginx doesn't proxy it), the socket simply
 * keeps retrying in the background and the 30s poll carries the load.
 */
function openNotificationSocket(userId: string, onNotification: () => void): NotificationSocket {
  const room = `user:${userId}`;
  let socket: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = WS_MIN_RECONNECT_DELAY;
  let closed = false;

  const clearPing = () => {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * WS_RECONNECT_MULTIPLIER, WS_MAX_RECONNECT_DELAY);
  };

  function connect() {
    if (closed) return;
    let next: WebSocket;
    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      next = new WebSocket(`${protocol}//${window.location.host}/b3/ws`);
    } catch {
      // Constructing the socket can throw on malformed URLs / blocked schemes.
      scheduleReconnect();
      return;
    }
    socket = next;

    next.onopen = () => {
      reconnectDelay = WS_MIN_RECONNECT_DELAY;
      try {
        next.send(JSON.stringify({ type: 'subscribe', room }));
      } catch {
        // ignore — close handler will reconnect
      }
      pingTimer = setInterval(() => {
        if (next.readyState === WebSocket.OPEN) {
          try {
            next.send(JSON.stringify({ type: 'ping' }));
          } catch {
            // ignore
          }
        }
      }, 30000);
    };

    next.onmessage = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data as string) as { type?: string };
        if (data.type === 'notification') {
          onNotification();
        }
        // All other frames (connected/subscribed/unsubscribed/pong/task.*)
        // are irrelevant to the bell and ignored.
      } catch {
        // Ignore malformed frames.
      }
    };

    next.onclose = () => {
      clearPing();
      if (!closed) scheduleReconnect();
    };

    next.onerror = () => {
      // The close event fires after this and drives reconnection.
    };
  }

  connect();

  return {
    close() {
      closed = true;
      clearPing();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (socket) {
        try {
          socket.close(1000, 'Client disconnect');
        } catch {
          // ignore
        }
        socket = null;
      }
    },
  };
}

// ── Component ────────────────────────────────────────────────

export function NotificationsBell({ inAppPrefix, onNavigate }: NotificationsBellProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Identity — fetched inside the component so the public props stay minimal.
  // /b3/api/auth/me returns { data: { id, active_org_id, org_id, ... } }.
  // (The route is /auth/me, not /me; /me 404s.) orgId falls back to org_id
  // when active_org_id is absent. Cached indefinitely-ish; the session rarely
  // changes within a page lifetime and a stale id just means one extra poll.
  const { data: me } = useQuery<MeIdentity>({
    queryKey: ['bbb', 'notifications', 'me'],
    queryFn: async () => {
      const res = await bbbGet<{
        data?: { id: string; active_org_id?: string | null; org_id?: string | null };
      }>('/auth/me');
      const d = res.data;
      return { id: d?.id ?? '', orgId: d?.active_org_id ?? d?.org_id ?? null };
    },
    staleTime: 5 * 60_000,
    retry: false,
  });
  const userId = me?.id || null;
  const orgId = me?.orgId ?? null;

  // Source A — persistent unread notification rows. The badge trusts the
  // server's meta.unread_count, not a client-side !is_read tally.
  const { data: notificationsRes } = useQuery({
    queryKey: ['bbb', 'notifications'],
    queryFn: () =>
      bbbGet<{ data: Notification[]; meta?: { unread_count?: number } }>(
        '/me/notifications?unread_only=true',
      ),
    refetchInterval: 30_000,
  });
  const notifications = useMemo(() => notificationsRes?.data ?? [], [notificationsRes]);
  const notificationUnreadCount = notificationsRes?.meta?.unread_count ?? 0;

  // Source B — Banter unread channels. Plain fetch (not the Bam helper)
  // because this hits /banter/api, forwarding X-Org-Id so the request is
  // pinned to the org this tab is viewing. If the header can't be built (no
  // orgId yet) or the request fails (no Banter in this deployment), we return
  // an empty list — a missing Banter must never break the host app's chrome.
  const { data: banterChannelsRes } = useQuery({
    queryKey: ['bbb', 'banter-unread', orgId ?? 'no-org'],
    queryFn: async () => {
      const headers: Record<string, string> = {};
      if (orgId) headers['X-Org-Id'] = orgId;
      const res = await fetch('/banter/api/v1/channels', {
        credentials: 'include',
        headers,
      });
      if (!res.ok) return [] as BanterChannel[];
      const body = (await res.json()) as { data?: BanterChannel[] };
      return (body.data ?? []).filter((c) => (c.unread_count ?? 0) > 0);
    },
    refetchInterval: 30_000,
    retry: false,
  });
  const unreadChannels = useMemo(() => banterChannelsRes ?? [], [banterChannelsRes]);
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
      const cat = n.category;
      const category: QueueItem['category'] =
        cat === 'assignment' || cat === 'task'
          ? 'assignment'
          : cat === 'invite'
            ? 'invite'
            : cat === 'knock'
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
        title: isDm ? (c.dm_other_participant?.display_name ?? 'Direct message') : `#${c.name}`,
        body: `${c.unread_count} new message${c.unread_count === 1 ? '' : 's'}`,
        timestamp: c.last_message_at ?? new Date(0).toISOString(),
        channel: c,
      });
    }

    return items.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime(),
    );
  }, [notifications, unreadChannels]);

  const refetchQueue = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['bbb', 'notifications'] });
    queryClient.invalidateQueries({ queryKey: ['bbb', 'banter-unread'] });
  }, [queryClient]);

  // Realtime — open the socket once we know who we are, tear it down on
  // unmount or identity change. invalidate-both-queries is the whole reaction.
  useEffect(() => {
    if (!userId) return;
    const conn = openNotificationSocket(userId, refetchQueue);
    return () => conn.close();
  }, [userId, refetchQueue]);

  // POST a Banter mark-read for one channel. The endpoint requires the latest
  // message_id, which the channels list doesn't expose, so we fetch the newest
  // message (limit=1, newest-first) to get it, then mark read. Best-effort.
  const markBanterChannelRead = useCallback(
    async (channel: BanterChannel) => {
      const headers: Record<string, string> = {};
      if (orgId) headers['X-Org-Id'] = orgId;
      const msgRes = await fetch(`/banter/api/v1/channels/${channel.id}/messages?limit=1`, {
        credentials: 'include',
        headers,
      });
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
    },
    [orgId],
  );

  const markOneRead = useMutation({
    mutationFn: (id: string) => bbbPost(`/me/notifications/${id}/read`),
  });

  // Clear all: mark every persistent notification read AND mark each unread
  // Banter channel read, then refetch so the queue empties.
  const clearAll = useMutation({
    mutationFn: async () => {
      await bbbPost('/me/notifications/mark-all-read').catch(() => {});
      await Promise.all(
        unreadChannels.map((c) => markBanterChannelRead(c).catch(() => {})),
      );
    },
    onSuccess: () => refetchQueue(),
  });

  // Close dropdown on outside click.
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Cross-app navigation. deep_link starting with inAppPrefix routes in-app
  // via onNavigate (strip the prefix, keep the leading slash); everything else
  // is a hard cross-app navigation via window.location.
  const navigateTo = (deepLink: string) => {
    if (deepLink.startsWith(inAppPrefix)) {
      const relative = deepLink.slice(inAppPrefix.length - 1) || '/';
      if (onNavigate) {
        onNavigate(relative);
      } else {
        window.location.href = deepLink;
      }
    } else {
      window.location.href = deepLink;
    }
  };

  // Optimistically drop a persistent notification from the queue + badge the
  // instant it's clicked, so it visibly clears even before the POST settles and
  // even if a navigation unloads the page mid-request.
  const dropNotificationFromCache = useCallback(
    (id: string) => {
      queryClient.setQueryData<{ data: Notification[]; meta?: { unread_count?: number } }>(
        ['bbb', 'notifications'],
        (old) => {
          if (!old) return old;
          const data = old.data.filter((n) => n.id !== id);
          const removed = old.data.length - data.length;
          return {
            ...old,
            data,
            meta: {
              ...old.meta,
              unread_count: Math.max(0, (old.meta?.unread_count ?? 0) - removed),
            },
          };
        },
      );
    },
    [queryClient],
  );

  // Same idea for a Banter unread channel item.
  const dropChannelFromCache = useCallback(
    (channelId: string) => {
      queryClient.setQueryData<BanterChannel[]>(
        ['bbb', 'banter-unread', orgId ?? 'no-org'],
        (old) => (old ? old.filter((c) => c.id !== channelId) : old),
      );
    },
    [queryClient, orgId],
  );

  const handleItemClick = (item: QueueItem) => {
    setOpen(false);

    if (item.kind === 'notification' && item.notification) {
      const n = item.notification;
      // Clear it from the UI immediately, then persist the read (keepalive POST
      // survives the navigation below).
      dropNotificationFromCache(n.id);
      markOneRead.mutate(n.id, { onSettled: () => refetchQueue() });
      // Invite/knock: acknowledge only — no navigation, it just leaves the queue.
      if (n.category === 'invite' || n.category === 'knock') return;
      const target = n.deep_link ?? (n.task_id ? `/b3/tasks/${n.task_id}` : null);
      if (target) navigateTo(target);
      return;
    }

    if (item.kind === 'banter-channel' && item.channel) {
      const channel = item.channel;
      // Optimistically drop it for instant badge feedback...
      dropChannelFromCache(channel.id);
      // ...but clicking MUST also mark the channel read server-side. The old
      // code only dropped the cache and hard-navigated, trusting "opening the
      // channel marks it read" — it doesn't reliably, so the destination page's
      // bell re-fetched the still-unread channel and the count snapped back
      // (the "click an alert, it still says 11" bug; only Clear all, which marks
      // every channel read, reduced the count). mark-read needs the latest
      // message id (two fetches), so await it before navigating so the read
      // persists across the page unload.
      markBanterChannelRead(channel)
        .catch(() => {})
        .finally(() => {
          window.location.href = `/banter/channels/${channel.slug}`;
        });
    }
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="relative rounded-lg p-2 text-zinc-500 hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
        title="Notifications"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Bell className="h-4.5 w-4.5" aria-hidden="true" />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Notifications"
          className="absolute right-0 top-full mt-1 z-50 w-80 max-h-96 overflow-y-auto rounded-xl border border-zinc-200 bg-white shadow-xl dark:bg-zinc-800 dark:border-zinc-700"
        >
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
                    type="button"
                    key={item.key}
                    role="menuitem"
                    onClick={() => handleItemClick(item)}
                    className="w-full text-left px-4 py-3 text-sm bg-primary-50/50 dark:bg-zinc-800/30 hover:bg-primary-100/60 dark:hover:bg-zinc-700/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
                  >
                    <div className="flex items-start gap-2">
                      <Icon
                        className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400 dark:text-zinc-500"
                        aria-hidden="true"
                      />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-zinc-900 dark:text-zinc-100 truncate">
                          {item.title}
                        </p>
                        <p className="text-zinc-500 dark:text-zinc-400 line-clamp-2">{item.body}</p>
                        <p className="text-xs text-zinc-400 mt-1">
                          {formatRelativeTime(item.timestamp)}
                        </p>
                      </div>
                      <span
                        className="mt-1.5 h-2 w-2 rounded-full bg-primary-500 shrink-0"
                        aria-label="Unread"
                      />
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
  );
}
