/**
 * BringPopover — multi-select "lead these people around" popover for the docked
 * box's "Bring…" button. Unlike Invite (which lists the whole org roster),
 * Bring only offers people who are currently CO-LOCATED with you: at the same
 * surface (GET /bureau/api/v1/presence/here?url=…) or in the same spatial room
 * (the docked box's occupants). You gather a group with Invite/summon, then
 * Bring leads them from place to place until either side cancels.
 *
 * Inline-styled (like the rest of the docked box) since it renders inside every
 * host SPA without a guaranteed Tailwind build. Selecting people and pressing
 * "Bring" hands the ids up to the parent, which sends bring_start over the WS.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { BureauOccupant } from './types.js';

export interface BringPopoverProps {
  /** The current page URL — used to find who else is "viewing the same thing". */
  surfaceUrl: string | null;
  /** Same-room occupants from the docked box (also counts as co-located). */
  occupants: BureauOccupant[];
  /** Excluded — you can't bring yourself. */
  selfUserId: string | null;
  /** Admin force (right-click): grant without asking. The server enforces. */
  force?: boolean;
  /** Hand the selected follower ids up; the parent sends bring_start + closes. */
  onStart: (followerIds: string[]) => void;
  onClose: () => void;
}

interface HereUser {
  user_id: string;
  display_name: string | null;
}

interface Candidate {
  id: string;
  name: string;
}

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

const listStyle: CSSProperties = { maxHeight: 200, overflowY: 'auto', margin: '6px 0' };

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
  background: checked ? '#f59e0b' : 'transparent',
  fontSize: 10,
  lineHeight: 1,
});

const footerStyle: CSSProperties = { display: 'flex', gap: 6, marginTop: 4 };

const goBtnStyle: CSSProperties = {
  flex: 1,
  background: '#f59e0b',
  color: '#1c1917',
  border: 'none',
  borderRadius: 6,
  padding: '5px 8px',
  cursor: 'pointer',
  fontWeight: 700,
  fontSize: 12,
};
const goBtnDisabledStyle: CSSProperties = {
  ...goBtnStyle,
  background: 'rgba(245, 158, 11, 0.35)',
  color: '#fef3c7',
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

export function BringPopover({
  surfaceUrl,
  occupants,
  selfUserId,
  force = false,
  onStart,
  onClose,
}: BringPopoverProps): React.ReactElement {
  const [here, setHere] = useState<HereUser[] | null>(null);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const panelRef = useRef<HTMLDialogElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const id = window.requestAnimationFrame(() => searchRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, []);

  // Who else is at this surface ("viewing the same thing").
  useEffect(() => {
    if (!surfaceUrl) {
      setHere([]);
      return;
    }
    let cancelled = false;
    fetch(`/bureau/api/v1/presence/here?url=${encodeURIComponent(surfaceUrl)}`, {
      credentials: 'include',
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as { data?: HereUser[] };
        if (!cancelled) setHere(Array.isArray(body?.data) ? body.data : []);
      })
      .catch(() => {
        if (!cancelled) setHere([]);
      });
    return () => {
      cancelled = true;
    };
  }, [surfaceUrl]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const onDocMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (target instanceof Element && target.closest('[data-bureau-bring-button]')) {
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

  // Co-located = same-room occupants ∪ same-surface "here" users, minus self.
  const candidates = useMemo<Candidate[]>(() => {
    const map = new Map<string, Candidate>();
    for (const o of occupants) {
      if (o.userId && o.userId !== selfUserId) {
        map.set(o.userId, { id: o.userId, name: o.name ?? 'Member' });
      }
    }
    for (const h of here ?? []) {
      if (h.user_id && h.user_id !== selfUserId) {
        map.set(h.user_id, { id: h.user_id, name: h.display_name ?? 'Member' });
      }
    }
    return [...map.values()];
  }, [occupants, here, selfUserId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? candidates.filter((c) => c.name.toLowerCase().includes(q)) : candidates;
  }, [candidates, query]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const loading = here === null;

  return (
    <dialog ref={panelRef} open style={panelStyle} aria-label="Bring people along">
      <input
        ref={searchRef}
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search people here…"
        style={searchInputStyle}
      />
      {force ? (
        <div style={forceBannerStyle} data-bureau-bring-force-banner>
          Force: people are pulled along immediately (admin/owner only). They can
          still leave any time.
        </div>
      ) : null}
      <div style={listStyle}>
        {loading ? (
          <div style={mutedStyle}>Finding people here…</div>
        ) : filtered.length === 0 ? (
          <div style={mutedStyle}>
            {query.trim() ? 'No matches' : 'No one else is here to bring along'}
          </div>
        ) : (
          filtered.map((c) => {
            const checked = selected.has(c.id);
            return (
              <button
                type="button"
                key={c.id}
                style={rowStyle}
                onClick={() => toggle(c.id)}
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
                >
                  {c.name}
                </span>
              </button>
            );
          })
        )}
      </div>
      <div style={footerStyle}>
        <button
          type="button"
          style={selected.size > 0 ? goBtnStyle : goBtnDisabledStyle}
          disabled={selected.size === 0}
          onClick={() => onStart([...selected])}
        >
          {selected.size > 0
            ? `${force ? 'Bring' : 'Lead'} ${selected.size} ${selected.size === 1 ? 'person' : 'people'}`
            : 'Bring'}
        </button>
        <button type="button" style={cancelBtnStyle} onClick={onClose}>
          Cancel
        </button>
      </div>
    </dialog>
  );
}
