import { and, eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { db } from '../db/index.js';
import { briefDocuments } from '../db/schema/index.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import { maybeSnapshotVersion } from './version.service.js';

// ---------------------------------------------------------------------------
// Yjs persistence service (Wave 2 stub for Hocuspocus integration)
// ---------------------------------------------------------------------------
//
// Goals (Brief_Plan.md §Services / G1):
//   - Provide a narrow, transport-agnostic surface that both a future
//     Hocuspocus server-side extension and an HTTP fallback endpoint can use
//     to load and persist Yjs binary state for a document.
//   - Debounce writes to at most once per 30 seconds per document, updating
//     the freshly-added brief_documents.yjs_last_saved_at column so background
//     snapshot / embed jobs can detect stale state cheaply.
//   - Stay fully functional without Hocuspocus in the dependency tree. Deep
//     collaboration (y-protocols awareness, Redis PubSub fan-out, multi-worker
//     coordination) is explicitly deferred to Wave 3.
//
// Non-goals for this stub:
//   - Merging updates with existing state. Callers send full `Y.encodeStateAsUpdate`
//     snapshots. Conflict resolution is last-write-wins until the full
//     Hocuspocus pipeline lands.
//   - Authorization. Route handlers are responsible for running requireDocumentEditAccess
//     before calling saveYjsState.
// ---------------------------------------------------------------------------

const DEBOUNCE_WINDOW_MS = 30_000;

interface PendingFlush {
  timer: NodeJS.Timeout;
  state: Buffer;
  orgId: string;
  userId: string;
  scheduledAt: number;
}

const pendingByDoc = new Map<string, PendingFlush>();

/**
 * Loads the current Yjs binary state for a document, or `null` if the document
 * has no persisted state yet. Orgs are enforced so a caller that has already
 * resolved {orgId} cannot accidentally read across tenants.
 */
export async function loadYjsState(
  docId: string,
  orgId: string,
): Promise<{ state: Uint8Array | null; yjs_last_saved_at: Date | null } | null> {
  const [row] = await db
    .select({
      yjs_state: briefDocuments.yjs_state,
      yjs_last_saved_at: briefDocuments.yjs_last_saved_at,
    })
    .from(briefDocuments)
    .where(and(eq(briefDocuments.id, docId), eq(briefDocuments.org_id, orgId)))
    .limit(1);

  if (!row) return null;

  return {
    state: row.yjs_state ? new Uint8Array(row.yjs_state) : null,
    yjs_last_saved_at: row.yjs_last_saved_at ?? null,
  };
}

/**
 * Extracts searchable plain text from a Yjs state snapshot. The Tiptap
 * Collaboration extension stores the document in the 'default' XmlFragment.
 * The tree is walked node-by-node — XmlText content is read via toDelta()
 * (raw text; Yjs's toString() embeds formatting tags AND leaves literal
 * `<`/`>` in user text unescaped, so it cannot be regex-stripped safely).
 * Top-level blocks become lines. Returns null when the fragment is empty so
 * callers can skip overwriting legacy plain_text with nothing.
 */
export function yjsStateToPlainText(state: Buffer | Uint8Array): string | null {
  const collect = (node: unknown): string => {
    if (node instanceof Y.XmlText) {
      return (node.toDelta() as { insert?: unknown }[])
        .map((op) => (typeof op.insert === 'string' ? op.insert : ' '))
        .join('');
    }
    if (node instanceof Y.XmlElement) {
      const parts: string[] = [];
      for (let i = 0; i < node.length; i++) {
        parts.push(collect(node.get(i)));
      }
      return parts.join(' ');
    }
    return '';
  };

  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state instanceof Buffer ? new Uint8Array(state) : state);
    const fragment = doc.getXmlFragment('default');
    if (fragment.length === 0) return null;
    const lines: string[] = [];
    for (let i = 0; i < fragment.length; i++) {
      const text = collect(fragment.get(i)).replace(/\s+/g, ' ').trim();
      if (text) lines.push(text);
    }
    const joined = lines.join('\n').trim();
    return joined || null;
  } catch {
    return null; // corrupt/foreign state — leave plain_text untouched
  } finally {
    doc.destroy();
  }
}

/**
 * Extracts collaborative metadata (title, summary) from a Yjs state snapshot.
 * The Brief editor mirrors the title + summary inputs into a shared `meta`
 * Y.Map so they sync live like the body; persisting them here keeps the
 * canonical columns (used by document lists, search, GET, and the static
 * viewer) current without requiring an explicit Save. Only keys that are
 * actually present and string-typed are returned — a legacy doc with no `meta`
 * map yields `{}`, so a column is never clobbered with junk. `title` is omitted
 * when blank (a document title must never become empty); `summary` round-trips
 * an empty string so a user can clear it.
 */
export function yjsStateToMeta(state: Buffer | Uint8Array): {
  title?: string;
  summary?: string;
} {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state instanceof Buffer ? new Uint8Array(state) : state);
    const meta = doc.getMap('meta');
    const out: { title?: string; summary?: string } = {};
    const t = meta.get('title');
    if (typeof t === 'string' && t.trim().length > 0) out.title = t.slice(0, 512);
    const s = meta.get('summary');
    if (typeof s === 'string') out.summary = s.slice(0, 2000);
    return out;
  } catch {
    return {};
  } finally {
    doc.destroy();
  }
}

/**
 * Writes a Yjs binary state immediately, updating yjs_last_saved_at and emitting
 * a `document.yjs_saved` Bolt event on the 6+1 canonical signature. Plain text
 * AND the collaborative title/summary are re-derived from the state in the same
 * write so search, embeds, lists, and the static viewer fallback never lag the
 * collaborative content by more than one debounce window.
 *
 * Returns `true` when a row was updated, `false` when the document is missing
 * or belongs to a different org.
 */
export async function saveYjsStateImmediate(
  docId: string,
  state: Buffer,
  orgId: string,
  userId: string,
): Promise<boolean> {
  const now = new Date();
  const plainText = yjsStateToPlainText(state);
  const meta = yjsStateToMeta(state);
  const [row] = await db
    .update(briefDocuments)
    .set({
      yjs_state: state,
      yjs_last_saved_at: now,
      updated_at: now,
      updated_by: userId,
      ...(plainText !== null ? { plain_text: plainText } : {}),
      ...(meta.title !== undefined ? { title: meta.title } : {}),
      ...(meta.summary !== undefined ? { summary: meta.summary } : {}),
    })
    .where(and(eq(briefDocuments.id, docId), eq(briefDocuments.org_id, orgId)))
    .returning({ id: briefDocuments.id });

  if (!row) return false;

  // Throttled version snapshot so continuous editing builds a revision history
  // (at most one auto-snapshot per VERSION_SNAPSHOT_THROTTLE_MS). Fire-and-forget.
  maybeSnapshotVersion(docId, userId, orgId).catch(() => {});

  // Fire-and-forget Bolt emission. Bare event name, source 'brief'.
  publishBoltEvent(
    'document.yjs_saved',
    'brief',
    {
      document_id: docId,
      bytes: state.byteLength,
      saved_at: now.toISOString(),
    },
    orgId,
    userId,
    'user',
  ).catch(() => {});

  return true;
}

/**
 * Schedules a debounced flush of the supplied Yjs state. If another call
 * arrives for the same document within DEBOUNCE_WINDOW_MS the latest state
 * replaces the pending one and the timer is reset. Pass `immediate: true` to
 * short-circuit the debounce, typically from an `onDisconnect` hook.
 *
 * Returns immediately; flushes run on the Node event loop.
 */
export function debounceYjsUpdate(
  docId: string,
  state: Buffer,
  orgId: string,
  userId: string,
  immediate = false,
): void {
  const existing = pendingByDoc.get(docId);
  if (existing) {
    clearTimeout(existing.timer);
  }

  if (immediate) {
    pendingByDoc.delete(docId);
    void saveYjsStateImmediate(docId, state, orgId, userId);
    return;
  }

  const timer = setTimeout(async () => {
    const pending = pendingByDoc.get(docId);
    pendingByDoc.delete(docId);
    if (!pending) return;
    try {
      await saveYjsStateImmediate(docId, pending.state, pending.orgId, pending.userId);
    } catch {
      // Swallow; the next save will retry. The route handler surfaces
      // synchronous errors when using saveYjsStateImmediate directly.
    }
  }, DEBOUNCE_WINDOW_MS);

  // Keep Node from holding the event loop open for the debounce timer on
  // graceful shutdown. unref exists on NodeJS.Timeout; TS infers it.
  timer.unref?.();

  pendingByDoc.set(docId, {
    timer,
    state,
    orgId,
    userId,
    scheduledAt: Date.now(),
  });
}

/**
 * Forces every pending debounced write to flush synchronously. Intended for
 * graceful shutdown hooks and tests. Returns the number of documents flushed.
 */
export async function flushAllPendingYjsWrites(): Promise<number> {
  const entries = Array.from(pendingByDoc.entries());
  let count = 0;
  for (const [docId, pending] of entries) {
    clearTimeout(pending.timer);
    pendingByDoc.delete(docId);
    try {
      const ok = await saveYjsStateImmediate(
        docId,
        pending.state,
        pending.orgId,
        pending.userId,
      );
      if (ok) count++;
    } catch {
      // Continue draining. Shutdown path must not throw.
    }
  }
  return count;
}

/**
 * Test helper so unit tests can assert the debounce map is empty between
 * cases without waiting on real timers.
 */
export function _resetYjsPersistenceForTests(): void {
  for (const pending of pendingByDoc.values()) {
    clearTimeout(pending.timer);
  }
  pendingByDoc.clear();
}
