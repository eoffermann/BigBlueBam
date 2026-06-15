import { useEffect, useRef, useMemo, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { useAuthStore } from '@/stores/auth.store';

// ---------------------------------------------------------------------------
// Yjs collaboration hook for Brief documents
//
// Creates a Y.Doc and connects a WebsocketProvider to brief-api's /ws
// endpoint. The provider handles the sync protocol, awareness, and
// automatic reconnection. Returns the doc and provider so the Tiptap
// Collaboration + CollaborationCursor extensions can bind to them.
// ---------------------------------------------------------------------------

const CURSOR_COLORS = [
  '#FF6B6B', // red
  '#4ECDC4', // teal
  '#45B7D1', // sky blue
  '#96CEB4', // sage
  '#FFEAA7', // yellow
  '#DDA0DD', // plum
  '#98D8C8', // mint
  '#F7DC6F', // gold
];

function pickColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length]!;
}

export interface CollaborationState {
  ydoc: Y.Doc;
  provider: WebsocketProvider | null;
  isConnected: boolean;
  isSynced: boolean;
}

/**
 * Manages a Yjs document and WebSocket provider for a given document ID.
 *
 * Returns a stable ydoc reference so Tiptap's Collaboration extension can bind
 * to it during editor initialization. The provider connects to the brief-api
 * WebSocket endpoint at /brief/ws?doc=<docId>.
 *
 * When `docId` is null/undefined, no connection is made (useful during initial
 * loading when the document ID is not yet known).
 */
export function useCollaboration(docId: string | null | undefined) {
  const user = useAuthStore((s) => s.user);
  const ydocRef = useRef<Y.Doc | null>(null);
  // State, not a ref: the consumer must RE-RENDER when the provider lands
  // so the Tiptap editor is built with CollaborationCursor bound. (The old
  // ref version meant the editor was created with provider=null and remote
  // cursors never attached until an unrelated re-render rebuilt it.)
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);
  // True once the provider has completed its first sync handshake with the
  // server — the signal that the shared doc now reflects persisted state
  // (used to decide whether a legacy doc needs one-time content seeding).
  const [isSynced, setIsSynced] = useState(false);

  // Create a stable Y.Doc for the lifetime of the docId
  const ydoc = useMemo(() => {
    if (ydocRef.current) {
      ydocRef.current.destroy();
    }
    const doc = new Y.Doc();
    ydocRef.current = doc;
    return doc;
  }, [docId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!docId || !user) return;

    // Build the WebSocket URL. nginx proxies /brief/ws on both deployment
    // profiles. y-websocket appends the room name to the PATH, so the final
    // URL is wss://host/brief/ws/<docId> — served by brief-api GET /ws/:docId.
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/brief/ws`;

    const p = new WebsocketProvider(wsUrl, docId, ydoc, {
      connect: true,
    });

    // Set awareness local state so other users see cursor info
    p.awareness.setLocalStateField('user', {
      // Never null — a missing display_name otherwise renders as the cursor
      // extension's "User: <clientId>" fallback for everyone else in the doc.
      name: user.display_name || user.email || 'Someone',
      color: pickColor(user.id),
      userId: user.id,
    });

    p.on('sync', (synced: boolean) => setIsSynced(synced));

    setProvider(p);

    return () => {
      setProvider(null);
      setIsSynced(false);
      p.disconnect();
      p.destroy();
    };
  }, [docId, user, ydoc]);

  // Clean up ydoc on unmount
  useEffect(() => {
    return () => {
      if (ydocRef.current) {
        ydocRef.current.destroy();
        ydocRef.current = null;
      }
    };
  }, []);

  // The cursor identity broadcast to peers. CollaborationCursor's plugin init
  // OVERWRITES the awareness `user` field with its own `user` option, so the
  // setLocalStateField above is not enough on its own — the editor must be
  // configured with this same object (see brief-editor.tsx) or every peer sees
  // the extension's "User: <clientId>" fallback.
  const cursorUser = useMemo(
    () =>
      user
        ? { name: user.display_name || user.email || 'Someone', color: pickColor(user.id) }
        : null,
    [user],
  );

  return {
    ydoc,
    provider,
    isSynced,
    cursorUser,
  };
}
