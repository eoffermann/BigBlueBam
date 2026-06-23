import { and, eq } from 'drizzle-orm';
import * as Y from 'yjs';
import { db } from '../db/index.js';
import { beaconEntries } from '../db/schema/index.js';

// ---------------------------------------------------------------------------
// Yjs persistence service (Beacon T4 real-time co-editing)
// ---------------------------------------------------------------------------
//
// Ported from apps/brief-api/src/services/yjs-persistence.service.ts. Beacon's
// contract differs from Brief's in three ways:
//
//   1. The collaborative body lives in a Y.Text named 'body' (the MARKDOWN
//      source), NOT a Y.XmlFragment. So materialization is a plain
//      `ydoc.getText('body').toString()` rather than an XML tree walk.
//   2. On save we write the materialized markdown to `body_markdown` and DO NOT
//      bump `updated_at`. `updated_at` drives the REST 409 stale-write guard for
//      title/summary/visibility edits (see beacon.routes.ts PUT /beacons/:id);
//      a body autosave must never trip that guard.
//   3. No Bolt event. Brief emits `document.yjs_saved`, but the Bolt event
//      catalog (apps/bolt-api/src/services/event-catalog.ts, outside this task's
//      edit scope) has no `beacon.yjs_saved` entry, and emitting an
//      unregistered (source, event_type) pair would fail the
//      scripts/check-bolt-catalog.mjs CI drift guard. The event is intentionally
//      omitted; add it (catalog entry + emission) in a follow-up if needed.
//
// Goals (mirrors Brief):
//   - Narrow, transport-agnostic surface the WS handler uses to load/persist
//     Yjs binary state for a beacon entry.
//   - Debounce writes to at most once per 30 seconds per beacon, updating
//     beacon_entries.yjs_last_saved_at so background jobs can detect stale state.
//   - Conflict resolution is last-write-wins: callers send full
//     `Y.encodeStateAsUpdate` snapshots; we do not merge.
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
 * Loads the current Yjs binary state for a beacon entry, or `null` if the entry
 * has no persisted state yet. Org is enforced so a caller that has already
 * resolved {orgId} cannot accidentally read across tenants.
 */
export async function loadYjsState(
  beaconId: string,
  orgId: string,
): Promise<{ state: Uint8Array | null; yjs_last_saved_at: Date | null } | null> {
  const [row] = await db
    .select({
      yjs_state: beaconEntries.yjs_state,
      yjs_last_saved_at: beaconEntries.yjs_last_saved_at,
    })
    .from(beaconEntries)
    .where(and(eq(beaconEntries.id, beaconId), eq(beaconEntries.organization_id, orgId)))
    .limit(1);

  if (!row) return null;

  return {
    state: row.yjs_state ? new Uint8Array(row.yjs_state) : null,
    yjs_last_saved_at: row.yjs_last_saved_at ?? null,
  };
}

/**
 * Materializes the markdown body from a Yjs state snapshot. The Beacon editor
 * stores the article markdown source in a Y.Text named 'body'. Returns `null`
 * when the body is empty so callers can skip overwriting a non-empty
 * body_markdown with nothing.
 */
export function yjsStateToBodyMarkdown(state: Buffer | Uint8Array): string | null {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, state instanceof Buffer ? new Uint8Array(state) : state);
    const md = doc.getText('body').toString();
    return md.length > 0 ? md : null;
  } catch {
    return null; // corrupt/foreign state — leave body_markdown untouched
  } finally {
    doc.destroy();
  }
}

/**
 * Writes a Yjs binary state immediately, updating yjs_last_saved_at and
 * re-deriving body_markdown from the collaborative state so REST GET / list /
 * search never lag the live content by more than one debounce window.
 *
 * IMPORTANT: this deliberately does NOT touch `updated_at`. `updated_at` is the
 * optimistic stale-write sentinel for title/summary/visibility edits; bumping it
 * on every keystroke-driven autosave would make every concurrent REST edit a
 * false 409.
 *
 * Returns `true` when a row was updated, `false` when the entry is missing or
 * belongs to a different org.
 */
export async function saveYjsStateImmediate(
  beaconId: string,
  state: Buffer,
  orgId: string,
  _userId: string,
): Promise<boolean> {
  const now = new Date();
  const bodyMarkdown = yjsStateToBodyMarkdown(state);
  const [row] = await db
    .update(beaconEntries)
    .set({
      yjs_state: state,
      yjs_last_saved_at: now,
      // NOTE: no `updated_at` bump — see the doc comment above.
      ...(bodyMarkdown !== null ? { body_markdown: bodyMarkdown } : {}),
    })
    .where(and(eq(beaconEntries.id, beaconId), eq(beaconEntries.organization_id, orgId)))
    .returning({ id: beaconEntries.id });

  if (!row) return false;

  // Bolt event intentionally omitted — see the module header. Brief emits
  // `document.yjs_saved`; Beacon has no registered `beacon.yjs_saved` event and
  // this task may not edit the Bolt catalog.

  return true;
}

/**
 * Schedules a debounced flush of the supplied Yjs state. If another call
 * arrives for the same beacon within DEBOUNCE_WINDOW_MS the latest state
 * replaces the pending one and the timer is reset. Pass `immediate: true` to
 * short-circuit the debounce, typically from a room-cleanup / disconnect path.
 *
 * Returns immediately; flushes run on the Node event loop.
 */
export function debounceYjsUpdate(
  beaconId: string,
  state: Buffer,
  orgId: string,
  userId: string,
  immediate = false,
): void {
  const existing = pendingByDoc.get(beaconId);
  if (existing) {
    clearTimeout(existing.timer);
  }

  if (immediate) {
    pendingByDoc.delete(beaconId);
    void saveYjsStateImmediate(beaconId, state, orgId, userId);
    return;
  }

  const timer = setTimeout(async () => {
    const pending = pendingByDoc.get(beaconId);
    pendingByDoc.delete(beaconId);
    if (!pending) return;
    try {
      await saveYjsStateImmediate(beaconId, pending.state, pending.orgId, pending.userId);
    } catch {
      // Swallow; the next save will retry.
    }
  }, DEBOUNCE_WINDOW_MS);

  // Keep Node from holding the event loop open for the debounce timer on
  // graceful shutdown.
  timer.unref?.();

  pendingByDoc.set(beaconId, {
    timer,
    state,
    orgId,
    userId,
    scheduledAt: Date.now(),
  });
}

/**
 * Forces every pending debounced write to flush synchronously. Intended for
 * graceful shutdown hooks and tests. Returns the number of beacons flushed.
 */
export async function flushAllPendingYjsWrites(): Promise<number> {
  const entries = Array.from(pendingByDoc.entries());
  let count = 0;
  for (const [beaconId, pending] of entries) {
    clearTimeout(pending.timer);
    pendingByDoc.delete(beaconId);
    try {
      const ok = await saveYjsStateImmediate(
        beaconId,
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
 * Test helper so unit tests can assert the debounce map is empty between cases
 * without waiting on real timers.
 */
export function _resetYjsPersistenceForTests(): void {
  for (const pending of pendingByDoc.values()) {
    clearTimeout(pending.timer);
  }
  pendingByDoc.clear();
}
