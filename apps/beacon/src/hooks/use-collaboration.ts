import { useEffect, useMemo, useRef, useState } from 'react';
import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
import { useAuthStore } from '@/stores/auth.store';

// ---------------------------------------------------------------------------
// Yjs collaboration hook for Beacon articles (T4 co-editing).
//
// Creates a Y.Doc whose `body` Y.Text holds the article's markdown source, and
// connects a WebsocketProvider to beacon-api's /ws endpoint (nginx exposes it
// at /beacon/ws). The provider drives the sync protocol, awareness, and
// reconnection; the CodeMirror editor binds to ydoc.getText('body') via
// y-codemirror.next. Mirrors Brief's use-collaboration, minus the Tiptap
// cursor-identity object (y-codemirror reads the awareness `user` field
// directly for remote cursors/labels).
// ---------------------------------------------------------------------------

const CURSOR_COLORS = [
  '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
  '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
];

function pickColor(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) | 0;
  }
  return CURSOR_COLORS[Math.abs(hash) % CURSOR_COLORS.length]!;
}

export interface BeaconCollaboration {
  ydoc: Y.Doc;
  provider: WebsocketProvider | null;
  isSynced: boolean;
}

/**
 * Manages a Yjs document + WebSocket provider for one beacon entry.
 * Pass `null` (e.g. while creating a not-yet-saved article) to make no
 * connection. Returns a stable ydoc so the editor can bind immediately, and
 * the provider once connected so the editor can attach awareness.
 */
export function useCollaboration(beaconId: string | null | undefined): BeaconCollaboration {
  const user = useAuthStore((s) => s.user);
  const ydocRef = useRef<Y.Doc | null>(null);
  const [provider, setProvider] = useState<WebsocketProvider | null>(null);
  const [isSynced, setIsSynced] = useState(false);

  const ydoc = useMemo(() => {
    if (ydocRef.current) ydocRef.current.destroy();
    const doc = new Y.Doc();
    ydocRef.current = doc;
    return doc;
  }, [beaconId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!beaconId || !user) return;

    // y-websocket appends the room name to the PATH, so the final URL is
    // wss://host/beacon/ws/<beaconId>, served by beacon-api GET /ws/:beaconId.
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/beacon/ws`;

    const p = new WebsocketProvider(wsUrl, beaconId, ydoc, { connect: true });

    p.awareness.setLocalStateField('user', {
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
  }, [beaconId, user, ydoc]);

  useEffect(() => {
    return () => {
      if (ydocRef.current) {
        ydocRef.current.destroy();
        ydocRef.current = null;
      }
    };
  }, []);

  return { ydoc, provider, isSynced };
}
