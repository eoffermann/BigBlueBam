/**
 * HuntPopover — find an org member and jump to wherever they are.
 *
 * Counterpart of InvitePopover (which pulls people TO you): Hunt takes
 * YOU to them. Pick a person from the org roster; the SDK asks
 * bureau-api `GET /v1/presence/where/:userId` for their current
 * location and, when located, navigates this tab there. The docked box
 * then auto-joins the same room they're in by the ordinary
 * "every place is a room" rule — no extra call set-up.
 *
 * Privacy lives server-side (org scoping, DND, destination-access
 * filtering — see presence-where.routes.ts). This component only ever
 * learns "located at <url>" or "not located"; an off-line, hidden, or
 * inaccessible target all render identically as "Not locatable".
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

export interface HuntPopoverProps {
  selfUserId: string | null;
  /** Host-app navigation callback (threaded from mountBureauClient). */
  navigate: (url: string) => void;
  onClose: () => void;
}

interface RosterMember {
  id: string;
  email: string;
  display_name: string;
}

type HuntOutcome = 'jumping' | 'unlocatable' | 'error';

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

const outcomeStyle = (outcome: HuntOutcome): CSSProperties => ({
  marginLeft: 'auto',
  flexShrink: 0,
  fontSize: 10,
  color:
    outcome === 'jumping' ? '#22c55e' : outcome === 'unlocatable' ? '#eab308' : '#fca5a5',
});

const mutedStyle: CSSProperties = { opacity: 0.6, padding: '6px 6px' };

function stripOrigin(url: string): string {
  try {
    const u = new URL(url, typeof window !== 'undefined' ? window.location.href : 'http://x/');
    return u.pathname + u.search + u.hash;
  } catch {
    return url;
  }
}

export function HuntPopover({
  selfUserId,
  navigate,
  onClose,
}: HuntPopoverProps): React.ReactElement {
  const [members, setMembers] = useState<RosterMember[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, HuntOutcome>>({});

  const panelRef = useRef<HTMLDialogElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, []);

  // Same canonical roster source as InvitePopover.
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
          setLoadError(err instanceof Error ? err.message : 'Failed to load members');
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (target instanceof Element && target.closest('[data-bureau-hunt-button]')) {
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

  const hunt = async (userId: string) => {
    if (busyId) return;
    setBusyId(userId);
    try {
      const res = await fetch(
        `/bureau/api/v1/presence/where/${encodeURIComponent(userId)}`,
        { credentials: 'include' },
      );
      if (!res.ok) {
        setOutcomes((prev) => ({ ...prev, [userId]: 'error' }));
        return;
      }
      const body = (await res.json()) as {
        data?: { located?: boolean; url?: string };
      };
      if (body?.data?.located && body.data.url) {
        setOutcomes((prev) => ({ ...prev, [userId]: 'jumping' }));
        navigate(stripOrigin(body.data.url));
        onClose();
      } else {
        setOutcomes((prev) => ({ ...prev, [userId]: 'unlocatable' }));
      }
    } catch {
      setOutcomes((prev) => ({ ...prev, [userId]: 'error' }));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <dialog ref={panelRef} open style={panelStyle} aria-label="Hunt for a person">
      <input
        ref={searchRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find someone…"
        style={searchInputStyle}
      />
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
            const outcome = outcomes[m.id];
            return (
              <button
                type="button"
                key={m.id}
                style={rowStyle}
                onClick={() => void hunt(m.id)}
                disabled={busyId !== null}
                title={`Jump to wherever ${m.display_name} is right now`}
              >
                <span
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {m.display_name}
                </span>
                {busyId === m.id ? (
                  <span style={{ marginLeft: 'auto', fontSize: 10, opacity: 0.7 }}>…</span>
                ) : outcome ? (
                  <span style={outcomeStyle(outcome)}>
                    {outcome === 'jumping'
                      ? 'jumping'
                      : outcome === 'unlocatable'
                        ? 'not locatable'
                        : 'failed'}
                  </span>
                ) : null}
              </button>
            );
          })
        )}
      </div>
    </dialog>
  );
}
