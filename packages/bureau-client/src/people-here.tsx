/**
 * PeopleHereButton — the "(X people here)" affordance on the docked box's
 * "In:" row.
 *
 * Shows a live count of who is present in the CURRENT SPACE — i.e. everyone
 * whose Bureau presence reports the same canonical URL the local user is on
 * (the same source `PresenceChipStrip` uses: GET /bureau/api/v1/presence/here).
 * Clicking the count pops a small name list. The count includes the local
 * user, so an empty room reads "1 person here" rather than vanishing.
 *
 * Polls every 15 s while a location URL is known (matching the chip strip's
 * cadence), refetches immediately on URL change, and skips polls while the
 * tab is hidden.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';

const POLL_MS = 15_000;

interface HereUser {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  status: string;
  status_emoji: string | null;
}

const countBtnStyle: CSSProperties = {
  background: 'rgba(255,255,255,0.08)',
  color: '#d4d4d8',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 999,
  padding: '1px 8px',
  fontSize: 11,
  lineHeight: '16px',
  cursor: 'pointer',
  whiteSpace: 'nowrap',
  flexShrink: 0,
};

const panelStyle: CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 6px)',
  right: 0,
  width: 200,
  background: 'rgba(24, 24, 27, 0.98)',
  color: '#fafafa',
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.12)',
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
  padding: 8,
  fontSize: 12,
  zIndex: 3,
};

const personRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 4px',
  borderRadius: 6,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

export function PeopleHereButton({ url }: { url: string | null }): React.ReactElement | null {
  const [others, setOthers] = useState<HereUser[]>([]);
  const [open, setOpen] = useState(false);
  const urlRef = useRef(url);
  urlRef.current = url;

  const refresh = useCallback(async () => {
    const target = urlRef.current;
    if (!target) return;
    try {
      const res = await fetch(
        `/bureau/api/v1/presence/here?url=${encodeURIComponent(target)}`,
        { credentials: 'include' },
      );
      if (!res.ok) return;
      const body = (await res.json()) as { data?: HereUser[] };
      // The URL may have changed while the request was in flight.
      if (urlRef.current !== target) return;
      setOthers(Array.isArray(body.data) ? body.data : []);
    } catch {
      // transient — keep the previous count rather than flickering to 1
    }
  }, []);

  useEffect(() => {
    setOthers([]);
    setOpen(false);
    if (!url) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void refresh();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [url, refresh]);

  if (!url) return null;

  const count = others.length + 1; // the endpoint excludes the caller
  const label = `${count} ${count === 1 ? 'person' : 'people'} here`;

  return (
    <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      <button
        type="button"
        style={countBtnStyle}
        data-bureau-people-here
        onClick={() => {
          if (!open) void refresh();
          setOpen((v) => !v);
        }}
        title="Who is in this space"
        aria-expanded={open}
      >
        {label}
      </button>
      {open ? (
        <>
          {/* Click-away veil */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 2 }}
            onClick={() => setOpen(false)}
          />
          <div style={panelStyle} role="dialog" aria-label="People in this space">
            <div
              style={{
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                opacity: 0.55,
                padding: '0 4px 4px',
              }}
            >
              In this space
            </div>
            <div style={{ maxHeight: 180, overflowY: 'auto' }}>
              <div style={personRowStyle}>
                <span aria-hidden>●</span>
                <span style={{ opacity: 0.8 }}>You</span>
              </div>
              {others.map((u) => (
                <div key={u.user_id} style={personRowStyle} title={u.status}>
                  <span aria-hidden>{u.status_emoji ?? '●'}</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {u.display_name ?? u.user_id.slice(0, 6)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      ) : null}
    </span>
  );
}
