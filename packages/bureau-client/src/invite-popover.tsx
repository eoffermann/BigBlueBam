/**
 * InvitePopover — multi-select "ring people to this surface" popover for the
 * docked box (Bureau todo #7).
 *
 * Lives in bureau-client (not apps/bureau) because the docked box renders
 * inside EVERY host SPA, where we can't rely on any one app's Tailwind build
 * being present — so, like the rest of the docked box, it is inline-styled.
 * (The original sketch reused apps/bureau's PeoplePicker; that component is
 * Tailwind-styled and app-local, so the picker UI is re-implemented here in
 * the docked box's own idiom instead.)
 *
 * Flow: fetch the org roster from Bam's canonical members endpoint, let the
 * user check any number of people, then POST /bureau/api/v1/ring once per
 * selection with the current surface coordinates. Each invitee's SDK shows
 * the IncomingCallOverlay; accepting navigates them to the surface, where
 * their ActiveCallManager joins the canonical huddle room.
 *
 * Per-recipient results surface inline: 423 RECIPIENT_DND renders as "DND"
 * (same semantics as the presence chip strip's ring button), other failures
 * as "failed". The popover stays open after sending so the caller can see
 * who actually got rung.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

export interface InvitePopoverProps {
  /** Ring-API surface app ('brief', 'board', 'bam', …, or 'url' for
   *  URL-derived rooms) — already mapped from location.app. */
  surfaceApp: string;
  surfaceId: string;
  surfaceLabel?: string | null;
  /** The page URL the invite points at. Required for 'url' surfaces
   *  (the hashed id can't be reversed); harmless enrichment otherwise. */
  surfaceUrl?: string | null;
  /**
   * Force-invite mode (opened via right-click; org admin/owner/SuperUser
   * only — the server enforces). The recipient gets a 3-second
   * cancellable auto-navigate instead of the accept prompt.
   */
  force?: boolean;
  /** Excluded from the roster — you can't ring yourself. */
  selfUserId: string | null;
  onClose: () => void;
}

interface RosterMember {
  id: string;
  email: string;
  display_name: string;
}

type RingOutcome = 'ok' | 'dnd' | 'forbidden' | 'error';

// Rendered as a native <dialog open>, so the UA defaults (left: 0,
// right: 0, margin: auto — which would center it) must be explicitly
// overridden to keep the panel pinned above the docked box.
const panelStyle: CSSProperties = {
  position: 'absolute',
  bottom: 'calc(100% + 8px)',
  top: 'auto',
  right: 0,
  left: 'auto',
  margin: 0,
  width: 260,
  background: 'rgba(24, 24, 27, 0.98)',
  color: '#fafafa',
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.12)',
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
  padding: 8,
  fontSize: 12,
  zIndex: 1,
};

const searchInputStyle: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: 'rgba(255,255,255,0.06)',
  color: '#fafafa',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  padding: '4px 8px',
  fontSize: 12,
  outline: 'none',
};

const listStyle: CSSProperties = {
  maxHeight: 200,
  overflowY: 'auto',
  margin: '6px 0',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  width: '100%',
  background: 'transparent',
  color: '#fafafa',
  border: 'none',
  borderRadius: 6,
  padding: '4px 6px',
  cursor: 'pointer',
  textAlign: 'left',
  fontSize: 12,
};

const checkboxStyle = (checked: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 14,
  height: 14,
  flexShrink: 0,
  borderRadius: 3,
  border: '1px solid rgba(255,255,255,0.3)',
  background: checked ? '#2563eb' : 'transparent',
  fontSize: 10,
  lineHeight: 1,
});

const footerStyle: CSSProperties = {
  display: 'flex',
  gap: 6,
  marginTop: 4,
};

const ringBtnStyle: CSSProperties = {
  flex: 1,
  background: '#2563eb',
  color: '#fff',
  border: 'none',
  borderRadius: 6,
  padding: '5px 8px',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 12,
};

const ringBtnDisabledStyle: CSSProperties = {
  ...ringBtnStyle,
  background: 'rgba(37, 99, 235, 0.35)',
  cursor: 'not-allowed',
};

const cancelBtnStyle: CSSProperties = {
  background: 'rgba(255,255,255,0.08)',
  color: '#fafafa',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  padding: '5px 8px',
  cursor: 'pointer',
  fontSize: 12,
};

const outcomeStyle = (outcome: RingOutcome): CSSProperties => ({
  marginLeft: 'auto',
  flexShrink: 0,
  fontSize: 10,
  color:
    outcome === 'ok' ? '#22c55e' : outcome === 'dnd' ? '#eab308' : '#fca5a5',
});

const forceBannerStyle: CSSProperties = {
  margin: '6px 0 0',
  padding: '4px 6px',
  borderRadius: 6,
  background: 'rgba(245, 158, 11, 0.15)',
  border: '1px solid rgba(245, 158, 11, 0.4)',
  color: '#fcd34d',
  fontSize: 11,
};

const mutedStyle: CSSProperties = { opacity: 0.6, padding: '6px 6px' };

export function InvitePopover({
  surfaceApp,
  surfaceId,
  surfaceLabel,
  surfaceUrl,
  force = false,
  selfUserId,
  onClose,
}: InvitePopoverProps): React.ReactElement {
  const [members, setMembers] = useState<RosterMember[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState(false);
  const [results, setResults] = useState<Record<string, RingOutcome> | null>(
    null,
  );

  const panelRef = useRef<HTMLDialogElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Focus the search input once mounted (same idiom as the bureau SPA's
  // PeoplePicker — rAF ensures the input exists before focus).
  useEffect(() => {
    const id = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, []);

  // Roster fetch — Bam's canonical org members endpoint (shared session).
  useEffect(() => {
    let cancelled = false;
    fetch('/b3/api/org/members', { credentials: 'include' })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { data?: RosterMember[] };
        if (!cancelled) setMembers(Array.isArray(body?.data) ? body.data : []);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoadError(
            err instanceof Error ? err.message : 'Failed to load members',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Esc + click-outside close. mousedown so a click landing inside the
  // popover doesn't race the re-render.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      // The trigger button toggles us via its own click handler, which fires
      // AFTER this mousedown — closing here would make the click re-open.
      if (
        target instanceof Element &&
        target.closest('[data-bureau-invite-button]')
      ) {
        return;
      }
      const root = panelRef.current;
      if (root && !root.contains(target)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDocMouseDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDocMouseDown);
    };
  }, [onClose]);

  const filtered = useMemo(() => {
    if (!members) return [];
    const q = query.trim().toLowerCase();
    return members.filter(
      (m) =>
        m.id !== selfUserId &&
        (!q ||
          m.display_name.toLowerCase().includes(q) ||
          m.email.toLowerCase().includes(q)),
    );
  }, [members, query, selfUserId]);

  const toggle = (id: string) => {
    if (sending || results) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const sendInvites = async () => {
    if (selected.size === 0 || sending) return;
    setSending(true);
    const outcomes: Record<string, RingOutcome> = {};
    for (const userId of selected) {
      try {
        const res = await fetch('/bureau/api/v1/ring', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to_user_id: userId,
            surface_app: surfaceApp,
            surface_id: surfaceId,
            surface_label: surfaceLabel ?? undefined,
            surface_url: surfaceUrl ?? undefined,
            force: force || undefined,
          }),
        });
        outcomes[userId] = res.ok
          ? 'ok'
          : res.status === 423
            ? 'dnd'
            : res.status === 403
              ? 'forbidden'
              : 'error';
      } catch {
        outcomes[userId] = 'error';
      }
    }
    setResults(outcomes);
    setSending(false);
  };

  const sent = results !== null;

  return (
    <dialog
      ref={panelRef}
      open
      style={panelStyle}
      aria-label={force ? 'Force invite people' : 'Invite people'}
    >
      <input
        ref={searchRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search by name or email…"
        style={searchInputStyle}
      />
      {force ? (
        <div style={forceBannerStyle} data-bureau-force-banner>
          Force invite: recipients are pulled here after a 3-second
          countdown they can cancel. Admin/owner only.
        </div>
      ) : null}
      <div style={listStyle}>
        {loadError ? (
          <div style={{ ...mutedStyle, color: '#fca5a5' }}>{loadError}</div>
        ) : members === null ? (
          <div style={mutedStyle}>Loading members…</div>
        ) : filtered.length === 0 ? (
          <div style={mutedStyle}>
            {query.trim() ? 'No matches' : 'No one else in this org'}
          </div>
        ) : (
          filtered.map((m) => {
            const checked = selected.has(m.id);
            const outcome = results?.[m.id];
            return (
              <button
                type="button"
                key={m.id}
                style={rowStyle}
                onClick={() => toggle(m.id)}
                aria-pressed={checked}
              >
                <span style={checkboxStyle(checked)} aria-hidden>
                  {checked ? '✓' : ''}
                </span>
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={m.email}
                >
                  {m.display_name}
                </span>
                {outcome ? (
                  <span style={outcomeStyle(outcome)}>
                    {outcome === 'ok'
                      ? force
                        ? 'pulled'
                        : 'ringing'
                      : outcome === 'dnd'
                        ? 'DND'
                        : outcome === 'forbidden'
                          ? 'not allowed'
                          : 'failed'}
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
      <div style={footerStyle}>
        {sent ? (
          <button type="button" style={ringBtnStyle} onClick={onClose}>
            Done
          </button>
        ) : (
          <>
            <button
              type="button"
              style={
                selected.size > 0 && !sending
                  ? ringBtnStyle
                  : ringBtnDisabledStyle
              }
              disabled={selected.size === 0 || sending}
              onClick={() => void sendInvites()}
            >
              {sending
                ? force
                  ? 'Pulling…'
                  : 'Ringing…'
                : selected.size > 0
                  ? `${force ? 'Pull' : 'Ring'} ${selected.size} ${selected.size === 1 ? 'person' : 'people'}`
                  : force
                    ? 'Pull'
                    : 'Ring'}
            </button>
            <button type="button" style={cancelBtnStyle} onClick={onClose}>
              Cancel
            </button>
          </>
        )}
      </div>
    </dialog>
  );
}
