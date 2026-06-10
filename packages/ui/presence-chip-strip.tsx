/**
 * Canonical PresenceChipStrip component shared across every collaborative
 * content surface in the BigBlueBam suite (Brief docs, Board canvases,
 * Blueprint diagrams, Bond deals, Bam tasks, Beacon articles, Helpdesk
 * tickets).
 *
 * Every frontend app imports this file via a Vite alias:
 *   '@bigbluebam/ui/presence-chip-strip' ->
 *     '<root>/packages/ui/presence-chip-strip.tsx'
 *
 * Polls GET <apiBase>/presence/here?url=<encoded> every 15s to discover the
 * other users currently looking at the same canonical URL (the surface), and
 * renders an avatar chip strip in the top-right of the host container.
 *
 * Hovering a chip opens a popover with two actions:
 *   - 'Send DM'           — opens a new tab to /banter/dm/<user_id>?context=<url>
 *   - 'Ring for huddle'   — POSTs to <apiBase>/ring; on 423 RECIPIENT_DND we
 *     downgrade to a 'Leave a note' affordance pointing back at Banter.
 *
 * Renders nothing while loading or when zero other users are present.
 * Tailwind-only, light + dark mode, no external deps beyond React +
 * lucide-react.
 *
 * The `presence/here` and `ring` endpoints live in bureau-api (see plan
 * docs/plans/presence-and-immediate-interaction.md §"What 'immediate
 * interaction' actually requires"). Until those land, this component fails
 * silently (renders nothing) so it can be safely mounted on every surface
 * during the rollout.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MessageSquare, Phone, StickyNote, X } from 'lucide-react';

export type PresenceSurfaceApp =
  | 'brief'
  | 'blueprint'
  | 'board'
  | 'bond'
  | 'bam'
  | 'beacon'
  | 'helpdesk';

export interface PresenceUser {
  user_id: string;
  display_name?: string | null;
  avatar_url?: string | null;
  status?: string | null;
  status_emoji?: string | null;
  is_dnd?: boolean;
}

export interface PresenceHereResponse {
  users?: PresenceUser[];
  // Alternate shape allowed for forward-compat with bureau-api's variant.
  occupants?: PresenceUser[];
}

export interface PresenceChipStripProps {
  /** Canonical URL of the current surface (used as the presence key). */
  url: string;
  /** Discriminator for the host app. */
  surfaceApp: PresenceSurfaceApp;
  /** The resource ID or slug for the surface. */
  surfaceId: string;
  /** Human-readable label for the surface (used in the ring payload). */
  surfaceLabel: string;
  /** Defaults to '/bureau/api/v1'. */
  apiBase?: string;
  /** Max chips before collapsing into a '+N' affordance. Defaults to 5. */
  maxVisible?: number;
}

const POLL_INTERVAL_MS = 15_000;

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

function generateAvatarInitials(name: string | null | undefined): string {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return '?';
  if (parts.length === 1) {
    return parts[0]!.substring(0, 2).toUpperCase();
  }
  const first = parts[0]![0] ?? '';
  const last = parts[parts.length - 1]![0] ?? '';
  return (first + last).toUpperCase();
}

// Deterministic color seed for the chip background fallback when no
// avatar_url is present. Same seed as packages/ui/launchpad uses.
function colorForUserId(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i += 1) {
    hash = (hash << 5) - hash + userId.charCodeAt(i);
    hash |= 0;
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 55%, 45%)`;
}

interface TinyToast {
  id: number;
  message: string;
  variant: 'info' | 'warn';
  actionLabel?: string;
  actionHref?: string;
}

let toastCounter = 0;

function PresenceToastHost({
  toasts,
  onDismiss,
}: {
  toasts: TinyToast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex items-center gap-3 rounded-lg border px-3 py-2 shadow-lg text-sm max-w-sm',
            t.variant === 'warn'
              ? 'bg-amber-50 border-amber-200 text-amber-900 dark:bg-amber-950/60 dark:border-amber-800 dark:text-amber-100'
              : 'bg-white border-zinc-200 text-zinc-800 dark:bg-zinc-900 dark:border-zinc-700 dark:text-zinc-100',
          )}
        >
          <span className="flex-1">{t.message}</span>
          {t.actionLabel && t.actionHref && (
            <a
              href={t.actionHref}
              target="_blank"
              rel="noreferrer"
              className="text-xs font-medium underline underline-offset-2 hover:no-underline"
            >
              {t.actionLabel}
            </a>
          )}
          <button
            type="button"
            onClick={() => onDismiss(t.id)}
            className="text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200"
            aria-label="Dismiss"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

interface ChipPopoverProps {
  user: PresenceUser;
  surfaceApp: PresenceSurfaceApp;
  surfaceId: string;
  surfaceLabel: string;
  contextUrl: string;
  apiBase: string;
  onClose: () => void;
  onToast: (toast: Omit<TinyToast, 'id'>) => void;
}

function ChipPopover({
  user,
  surfaceApp,
  surfaceId,
  surfaceLabel,
  contextUrl,
  apiBase,
  onClose,
  onToast,
}: ChipPopoverProps) {
  const displayName = user.display_name?.trim() || 'this user';
  const dmHref = `/banter/dm/${encodeURIComponent(
    user.user_id,
  )}?context=${encodeURIComponent(contextUrl)}`;
  const noteHref = `/banter/dm/${encodeURIComponent(
    user.user_id,
  )}?context=${encodeURIComponent(contextUrl)}&mode=note`;

  const [isRinging, setIsRinging] = useState(false);

  const handleRing = useCallback(async () => {
    if (isRinging) return;
    setIsRinging(true);
    try {
      const res = await fetch(`${apiBase}/ring`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          to_user_id: user.user_id,
          surface_app: surfaceApp,
          surface_id: surfaceId,
          surface_label: surfaceLabel,
        }),
      });
      if (res.status === 423) {
        // RECIPIENT_DND — offer the Banter note fallback.
        onToast({
          message: `${displayName} has DND on. Try sending a note via Banter?`,
          variant: 'warn',
          actionLabel: 'Leave a note',
          actionHref: noteHref,
        });
      } else if (res.ok) {
        onToast({
          message: `Ringing ${displayName}…`,
          variant: 'info',
        });
      } else {
        onToast({
          message: `Could not ring ${displayName} (status ${res.status}).`,
          variant: 'warn',
        });
      }
    } catch {
      onToast({
        message: `Could not ring ${displayName}. Network error.`,
        variant: 'warn',
      });
    } finally {
      setIsRinging(false);
      onClose();
    }
  }, [
    apiBase,
    displayName,
    isRinging,
    noteHref,
    onClose,
    onToast,
    surfaceApp,
    surfaceId,
    surfaceLabel,
    user.user_id,
  ]);

  return (
    <div
      className={cn(
        'absolute right-0 top-full mt-2 z-50 w-56 rounded-lg border shadow-xl',
        'bg-white border-zinc-200 dark:bg-zinc-900 dark:border-zinc-700',
        'animate-in fade-in-0 zoom-in-95 duration-100',
      )}
      role="dialog"
    >
      <div className="px-3 py-2 border-b border-zinc-100 dark:border-zinc-800">
        <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100 truncate flex items-center gap-1.5">
          {user.status_emoji && (
            <span aria-hidden className="text-base leading-none">
              {user.status_emoji}
            </span>
          )}
          <span className="truncate">{displayName}</span>
        </p>
        {user.status && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400 truncate mt-0.5">
            {user.status}
          </p>
        )}
      </div>
      <div className="p-1">
        <a
          href={dmHref}
          target="_blank"
          rel="noreferrer"
          className={cn(
            'flex items-center gap-2 rounded-md px-3 py-2 text-sm cursor-pointer outline-none w-full',
            'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800',
          )}
          onClick={onClose}
        >
          <MessageSquare className="h-4 w-4" />
          Send DM
        </a>
        {user.is_dnd ? (
          <a
            href={noteHref}
            target="_blank"
            rel="noreferrer"
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-2 text-sm cursor-pointer outline-none w-full',
              'text-amber-700 dark:text-amber-300 hover:bg-amber-50 dark:hover:bg-amber-950/40',
            )}
            onClick={onClose}
            title="They have Do Not Disturb on"
          >
            <StickyNote className="h-4 w-4" />
            Leave a note (DND)
          </a>
        ) : (
          <button
            type="button"
            onClick={handleRing}
            disabled={isRinging}
            className={cn(
              'flex items-center gap-2 rounded-md px-3 py-2 text-sm cursor-pointer outline-none w-full text-left',
              'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800',
              'disabled:opacity-60 disabled:cursor-not-allowed',
            )}
          >
            <Phone className="h-4 w-4" />
            {isRinging ? 'Ringing…' : 'Ring for huddle'}
          </button>
        )}
      </div>
    </div>
  );
}

interface ChipProps {
  user: PresenceUser;
  onOpen: () => void;
}

function PresenceChip({ user, onOpen }: ChipProps) {
  const initials = generateAvatarInitials(user.display_name);
  const ring = user.is_dnd
    ? 'ring-amber-400 dark:ring-amber-500'
    : 'ring-emerald-400 dark:ring-emerald-500';
  return (
    <button
      type="button"
      onMouseEnter={onOpen}
      onFocus={onOpen}
      onClick={onOpen}
      className={cn(
        'relative inline-flex h-7 w-7 items-center justify-center rounded-full overflow-hidden',
        'ring-2 ring-offset-1 ring-offset-white dark:ring-offset-zinc-900',
        ring,
        '-ml-1.5 first:ml-0 transition-transform hover:scale-110 focus-visible:outline-none',
      )}
      title={user.display_name ?? 'User'}
      aria-label={`Open quick actions for ${user.display_name ?? 'user'}`}
    >
      {user.avatar_url ? (
        <img
          src={user.avatar_url}
          alt={user.display_name ?? 'Avatar'}
          className="h-full w-full object-cover"
        />
      ) : (
        <span
          className="h-full w-full flex items-center justify-center text-[10px] font-semibold text-white"
          style={{ backgroundColor: colorForUserId(user.user_id) }}
        >
          {initials}
        </span>
      )}
    </button>
  );
}

export function PresenceChipStrip({
  url,
  surfaceApp,
  surfaceId,
  surfaceLabel,
  apiBase = '/bureau/api/v1',
  maxVisible = 5,
}: PresenceChipStripProps) {
  const [users, setUsers] = useState<PresenceUser[] | null>(null);
  const [openPopoverFor, setOpenPopoverFor] = useState<string | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [toasts, setToasts] = useState<TinyToast[]>([]);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Poll loop.
  useEffect(() => {
    if (!url) return;
    let cancelled = false;

    const fetchOnce = async () => {
      try {
        const res = await fetch(
          `${apiBase}/presence/here?url=${encodeURIComponent(url)}`,
          { credentials: 'include' },
        );
        if (!res.ok) {
          // Fail silently — endpoint may not be deployed yet during rollout.
          if (!cancelled) setUsers([]);
          return;
        }
        const payload = (await res.json()) as PresenceHereResponse;
        if (cancelled) return;
        const list = payload.users ?? payload.occupants ?? [];
        setUsers(Array.isArray(list) ? list : []);
      } catch {
        if (!cancelled) setUsers([]);
      }
    };

    void fetchOnce();
    const interval = window.setInterval(fetchOnce, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [apiBase, url]);

  // Dismiss popover on outside click.
  useEffect(() => {
    if (!openPopoverFor && !overflowOpen) return;
    const handler = (ev: MouseEvent) => {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(ev.target as Node)) {
        setOpenPopoverFor(null);
        setOverflowOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [openPopoverFor, overflowOpen]);

  const visibleUsers = useMemo(() => users ?? [], [users]);

  const pushToast = useCallback((toast: Omit<TinyToast, 'id'>) => {
    toastCounter += 1;
    const id = toastCounter;
    setToasts((prev) => [...prev, { ...toast, id }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 5000);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  // Hide while loading or when nobody else is here.
  if (users === null || visibleUsers.length === 0) {
    return <PresenceToastHost toasts={toasts} onDismiss={dismissToast} />;
  }

  const head = visibleUsers.slice(0, maxVisible);
  const overflow = visibleUsers.slice(maxVisible);

  return (
    <>
      <div
        ref={containerRef}
        className="relative inline-flex items-center"
        data-testid="presence-chip-strip"
      >
        <div className="flex items-center">
          {head.map((u) => (
            <div key={u.user_id} className="relative">
              <PresenceChip
                user={u}
                onOpen={() => {
                  setOverflowOpen(false);
                  setOpenPopoverFor(u.user_id);
                }}
              />
              {openPopoverFor === u.user_id && (
                <ChipPopover
                  user={u}
                  surfaceApp={surfaceApp}
                  surfaceId={surfaceId}
                  surfaceLabel={surfaceLabel}
                  contextUrl={url}
                  apiBase={apiBase}
                  onClose={() => setOpenPopoverFor(null)}
                  onToast={pushToast}
                />
              )}
            </div>
          ))}
          {overflow.length > 0 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => {
                  setOpenPopoverFor(null);
                  setOverflowOpen((v) => !v);
                }}
                className={cn(
                  'inline-flex h-7 min-w-7 items-center justify-center rounded-full px-1.5 -ml-1.5',
                  'ring-2 ring-offset-1 ring-offset-white dark:ring-offset-zinc-900',
                  'ring-zinc-300 dark:ring-zinc-700',
                  'bg-zinc-100 dark:bg-zinc-800 text-[10px] font-semibold',
                  'text-zinc-700 dark:text-zinc-200 hover:bg-zinc-200 dark:hover:bg-zinc-700',
                  'transition-colors focus-visible:outline-none',
                )}
                aria-label={`Show ${overflow.length} more user${
                  overflow.length === 1 ? '' : 's'
                }`}
              >
                +{overflow.length}
              </button>
              {overflowOpen && (
                <div
                  className={cn(
                    'absolute right-0 top-full mt-2 z-50 w-56 rounded-lg border shadow-xl',
                    'bg-white border-zinc-200 dark:bg-zinc-900 dark:border-zinc-700',
                    'animate-in fade-in-0 zoom-in-95 duration-100 max-h-72 overflow-auto',
                  )}
                >
                  {overflow.map((u) => (
                    <button
                      key={u.user_id}
                      type="button"
                      onClick={() => {
                        setOverflowOpen(false);
                        setOpenPopoverFor(u.user_id);
                      }}
                      className={cn(
                        'flex items-center gap-2 w-full text-left px-3 py-2 text-sm',
                        'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800',
                      )}
                    >
                      <span
                        className="inline-flex h-6 w-6 items-center justify-center rounded-full overflow-hidden text-[10px] font-semibold text-white"
                        style={{ backgroundColor: colorForUserId(u.user_id) }}
                      >
                        {u.avatar_url ? (
                          <img
                            src={u.avatar_url}
                            alt={u.display_name ?? 'Avatar'}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          generateAvatarInitials(u.display_name)
                        )}
                      </span>
                      <span className="truncate flex-1">
                        {u.display_name ?? 'Unknown'}
                      </span>
                      {u.status_emoji && (
                        <span aria-hidden className="text-base leading-none">
                          {u.status_emoji}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      <PresenceToastHost toasts={toasts} onDismiss={dismissToast} />
    </>
  );
}
