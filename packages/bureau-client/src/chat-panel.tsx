/**
 * ChatPanel — the docked box's room text chat.
 *
 * Pops out beside the widget on whichever side has more screen space
 * (the side farthest from the viewport edge), can be undocked into a
 * free-floating draggable window, or closed (messages keep arriving —
 * the toggle badge counts unread).
 *
 * The panel is presentation-only: message state, joining, and sending
 * live in the provider (see the chat section of index.tsx) so blips and
 * unread counts work while the panel is closed.
 */

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import type { BureauChatMessage } from './types.js';

export interface ChatPanelProps {
  roomLabel: string;
  messages: BureauChatMessage[];
  selfUserId: string | null;
  onSend: (body: string) => void;
  onClose: () => void;
  /** The docked widget box, used to pick the pop-out side. */
  anchorRef: React.RefObject<HTMLElement | null>;
}

const panelBaseStyle: CSSProperties = {
  width: 260,
  height: 320,
  display: 'flex',
  flexDirection: 'column',
  background: 'rgba(24, 24, 27, 0.98)',
  color: '#fafafa',
  borderRadius: 10,
  border: '1px solid rgba(255,255,255,0.12)',
  boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
  fontSize: 12,
  overflow: 'hidden',
};

const headerStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '6px 8px',
  borderBottom: '1px solid rgba(255,255,255,0.1)',
  cursor: 'default',
  userSelect: 'none',
};

const headerBtnStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'rgba(250,250,250,0.6)',
  cursor: 'pointer',
  padding: '0 4px',
  fontSize: 12,
  lineHeight: '16px',
  borderRadius: 4,
};

const inputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  background: 'rgba(255,255,255,0.06)',
  color: '#fafafa',
  border: '1px solid rgba(255,255,255,0.12)',
  borderRadius: 6,
  padding: '5px 8px',
  fontSize: 12,
  outline: 'none',
};

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

export function ChatPanel({
  roomLabel,
  messages,
  selfUserId,
  onSend,
  onClose,
  anchorRef,
}: ChatPanelProps): React.ReactElement {
  const [draft, setDraft] = useState('');
  // Docked: absolute beside the widget; side picked once on open by
  // which side of the anchor has more viewport room. Undocked: fixed at
  // a user-draggable position.
  const [undocked, setUndocked] = useState<{ x: number; y: number } | null>(null);
  const [sideLeft, setSideLeft] = useState(false);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor || typeof window === 'undefined') return;
    const rect = anchor.getBoundingClientRect();
    const spaceLeft = rect.left;
    const spaceRight = window.innerWidth - rect.right;
    // "Whichever side is farthest from the screen edge": open into the
    // larger gap so the panel never spills off-screen.
    setSideLeft(spaceLeft > spaceRight);
  }, [anchorRef]);

  // Stick to the bottom as messages arrive.
  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages.length]);

  const undock = () => {
    const rect = panelRef.current?.getBoundingClientRect();
    setUndocked({ x: rect?.left ?? 120, y: rect?.top ?? 120 });
  };

  const onHeaderPointerDown = (e: React.PointerEvent) => {
    if (!undocked) return;
    if ((e.target as HTMLElement).closest('button')) return;
    dragRef.current = { dx: e.clientX - undocked.x, dy: e.clientY - undocked.y };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setUndocked({
        x: Math.max(0, Math.min(window.innerWidth - 80, ev.clientX - d.dx)),
        y: Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - d.dy)),
      });
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const send = () => {
    const body = draft.trim();
    if (!body) return;
    onSend(body);
    setDraft('');
  };

  const positionStyle: CSSProperties = undocked
    ? { position: 'fixed', left: undocked.x, top: undocked.y, zIndex: 2147483000 }
    : sideLeft
      ? { position: 'absolute', right: 'calc(100% + 8px)', bottom: 0, zIndex: 5 }
      : { position: 'absolute', left: 'calc(100% + 8px)', bottom: 0, zIndex: 5 };

  return (
    <div
      ref={panelRef}
      style={{ ...panelBaseStyle, ...positionStyle }}
      data-bureau-chat-panel
      role="log"
      aria-label={`Room chat: ${roomLabel}`}
    >
      <div
        style={{ ...headerStyle, cursor: undocked ? 'grab' : 'default' }}
        onPointerDown={onHeaderPointerDown}
        title={undocked ? 'Drag to move' : roomLabel}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontWeight: 600,
          }}
        >
          {roomLabel || 'Room chat'}
        </span>
        {!undocked ? (
          <button
            type="button"
            style={headerBtnStyle}
            onClick={undock}
            title="Undock chat (drag it anywhere)"
            aria-label="Undock chat"
          >
            ⇱
          </button>
        ) : (
          <button
            type="button"
            style={headerBtnStyle}
            onClick={() => setUndocked(null)}
            title="Dock chat back to the widget"
            aria-label="Dock chat"
          >
            ⇲
          </button>
        )}
        <button
          type="button"
          style={headerBtnStyle}
          onClick={onClose}
          title="Close chat"
          aria-label="Close chat"
        >
          ✕
        </button>
      </div>

      <div ref={listRef} style={{ flex: 1, overflowY: 'auto', padding: '6px 8px' }}>
        {messages.length === 0 ? (
          <div style={{ opacity: 0.5, padding: '8px 0' }}>
            Nothing yet. Messages here vanish after 24 hours unless an admin
            retains them.
          </div>
        ) : (
          messages.map((m) => {
            const own = !!selfUserId && m.author_id === selfUserId;
            return (
              <div key={m.id} style={{ marginBottom: 6 }}>
                <span style={{ fontWeight: 600, color: own ? '#93c5fd' : '#e5e7eb' }}>
                  {own ? 'You' : m.author_name}
                </span>{' '}
                <span style={{ opacity: 0.45, fontSize: 10 }}>{formatTime(m.created_at)}</span>
                <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{m.body}</div>
              </div>
            );
          })
        )}
      </div>

      <div style={{ display: 'flex', gap: 6, padding: 8, borderTop: '1px solid rgba(255,255,255,0.1)' }}>
        <input
          type="text"
          style={inputStyle}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Message the room…"
          maxLength={2000}
          aria-label="Chat message"
        />
        <button
          type="button"
          style={{
            ...headerBtnStyle,
            background: 'rgba(59,130,246,0.35)',
            border: '1px solid rgba(147,197,253,0.5)',
            borderRadius: 6,
            padding: '0 10px',
          }}
          onClick={send}
          disabled={!draft.trim()}
          aria-label="Send message"
        >
          Send
        </button>
      </div>
    </div>
  );
}
