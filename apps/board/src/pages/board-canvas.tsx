import { useState, useCallback, useRef, useEffect } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { BoardToolbar } from '@/components/canvas/board-toolbar';
import { ChatPanel } from '@/components/canvas/chat-panel';
import { ConnectionStatusBadge } from '@/components/canvas/connection-status-badge';
import { BoardIntegrityBanner } from '@/components/canvas/board-integrity-banner';
import { useBoardSync } from '@/hooks/use-board-sync';

interface BoardCanvasPageProps {
  boardId: string;
  onNavigate: (path: string) => void;
}

/* ------------------------------------------------------------------ */
/*  Local persistence (reliable — survives refresh)                    */
/* ------------------------------------------------------------------ */

const STORAGE_KEY_PREFIX = 'excalidraw-board-';

function loadSavedScene(boardId: string) {
  try {
    const saved = localStorage.getItem(STORAGE_KEY_PREFIX + boardId);
    if (saved) {
      const parsed = JSON.parse(saved);
      if (parsed?.elements?.length > 0) return parsed;
    }
  } catch {
    /* ignore corrupt data */
  }
  return null;
}

let saveTimer: ReturnType<typeof setTimeout>;
function debouncedSave(boardId: string, elements: readonly any[], appState: Record<string, any>, files: any) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      // Only save app state fields that matter for restoring the view
      const cleanState = {
        viewBackgroundColor: appState.viewBackgroundColor,
        gridSize: appState.gridSize,
      };
      localStorage.setItem(
        STORAGE_KEY_PREFIX + boardId,
        JSON.stringify({ elements, appState: cleanState, files }),
      );
    } catch {
      /* localStorage full or unavailable */
    }
  }, 500);
}

/* ------------------------------------------------------------------ */
/*  Server persistence (best-effort — for collaboration & backup)      */
/* ------------------------------------------------------------------ */

let serverSaveTimer: ReturnType<typeof setTimeout>;
function debouncedServerSave(boardId: string, elements: readonly any[]) {
  clearTimeout(serverSaveTimer);
  serverSaveTimer = setTimeout(() => {
    fetch(`/board/api/v1/boards/${boardId}/scene`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ elements }),
    }).catch(() => {/* ignore */});
  }, 3000);
}

function getTheme(): 'dark' | 'light' {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function BoardCanvasPage({ boardId, onNavigate }: BoardCanvasPageProps) {
  const [chatOpen, setChatOpen] = useState(false);
  const [isDark] = useState(() => getTheme() === 'dark');
  const excalidrawAPIRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const getAPI = useCallback(() => excalidrawAPIRef.current, []);
  // Track when Excalidraw hands us its imperative API. The server-scene load
  // below needs the API to exist; on a fresh mount the ref is still null when
  // the effect first runs, so without this flag in the deps the fetch bailed
  // and the board rendered empty (saved scene never loaded on a new device).
  const [apiReady, setApiReady] = useState(false);

  // Real-time sync via WebSocket (layered on top of localStorage persistence)
  const { sendChanges, sendPointer, status, peerCount } = useBoardSync(boardId, getAPI);

  // Load initial data: prefer localStorage, fall back to server, then empty
  const [initialData] = useState(() => {
    const local = loadSavedScene(boardId);
    if (local) return local;
    return { elements: [], appState: { viewBackgroundColor: '#ffffff' } };
  });

  // Also try loading from server (in case another device saved there)
  useEffect(() => {
    const api = excalidrawAPIRef.current;
    if (!api) return;

    const localHasContent = (initialData?.elements?.length ?? 0) > 0;
    if (localHasContent) return; // local data takes priority

    fetch(`/board/api/v1/boards/${boardId}/scene`, { credentials: 'include' })
      .then((res) => (res.ok ? res.json() : null))
      // The scene endpoint wraps its payload in the standard API envelope
      // ({ data: { elements, ... } }), so the elements live at data.data,
      // not data. Reading the wrong level meant the saved scene was never
      // loaded on a fresh device and the canvas always opened empty.
      .then((res) => {
        const elements = res?.data?.elements;
        if (elements?.length > 0 && excalidrawAPIRef.current) {
          excalidrawAPIRef.current.updateScene({ elements });
        }
      })
      .catch(() => {/* ignore */});
  }, [boardId, initialData, apiReady]);

  // Track the last set of elements so the beforeunload beacon can flush
  // them synchronously when the user closes the tab. Without this the
  // 3s HTTP debounce can be in-flight when the page unloads, the fetch
  // gets cancelled, and the WS scene_update is the only writer — but
  // its server-side persist runs on the 5s `dirtyBoards` flush timer
  // and there's a window where the dirty entry hasn't been written yet.
  // sendBeacon is fire-and-forget, browser-supported, and survives the
  // unload event.
  const latestElementsRef = useRef<readonly any[]>([]);

  const handleChange = useCallback(
    (elements: readonly any[], appState: Record<string, any>, files: any) => {
      latestElementsRef.current = elements;
      debouncedSave(boardId, elements, appState, files);
      debouncedServerSave(boardId, elements);
      sendChanges(elements);
    },
    [boardId, sendChanges],
  );

  // beforeunload-time beacon flush. Runs synchronously enough that
  // navigator.sendBeacon's queued POST survives tab close. The beacon
  // endpoint persists straight to boards.yjs_state (bypasses the Redis
  // dirty hash) so we don't depend on the 5s flush timer firing before
  // the replica gets recycled / scaled down. No-op when the beacon API
  // is unavailable (very old browsers); the WS flush-on-empty hook will
  // pick up the slack in that case.
  useEffect(() => {
    const handler = () => {
      const els = latestElementsRef.current;
      if (!els || els.length === 0) return;
      try {
        const blob = new Blob([JSON.stringify({ elements: els })], {
          type: 'application/json',
        });
        navigator.sendBeacon(`/board/api/v1/boards/${boardId}/scene/beacon`, blob);
      } catch {
        // sendBeacon throws on quota / disabled browsers; the WS
        // last-collaborator-leaves flush is the fallback.
      }
    };
    window.addEventListener('beforeunload', handler);
    window.addEventListener('pagehide', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
      window.removeEventListener('pagehide', handler);
    };
  }, [boardId]);

  return (
    <div className="flex flex-col h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Integrity banner. Renders nothing for healthy boards. */}
      <BoardIntegrityBanner boardId={boardId} />
      <div className="flex-1 relative">
        <div style={{ height: '100%', width: '100%' }}>
          <Excalidraw
            excalidrawAPI={(api) => {
              excalidrawAPIRef.current = api;
              setApiReady(true);
            }}
            initialData={initialData}
            onChange={handleChange}
            onPointerUpdate={sendPointer}
            theme={isDark ? 'dark' : 'light'}
            validateEmbeddable
          />
        </div>

        {/* Floating toolbar on top of canvas */}
        <BoardToolbar
          boardId={boardId}
          onNavigate={onNavigate}
          onToggleChat={() => setChatOpen((prev) => !prev)}
          chatOpen={chatOpen}
        />

        {/* Real-time connection + peer-count indicator */}
        <ConnectionStatusBadge status={status} peerCount={peerCount} />

        {/* Chat panel overlay */}
        <ChatPanel
          boardId={boardId}
          open={chatOpen}
          onClose={() => setChatOpen(false)}
        />
      </div>
    </div>
  );
}
