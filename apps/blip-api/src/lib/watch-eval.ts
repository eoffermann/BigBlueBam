/**
 * Blip watch evaluation on the ingest edge (Blip §12.1).
 *
 * Match watches: evaluated per-entry against the redacted record; on a match,
 * honor the per-watch Redis cooldown and emit `entry.matched`.
 *
 * Window watches: the edge only bumps lightweight per-watch reservoirs in Redis
 * (one ZADD); the blip-watch-eval worker tick evaluates the threshold and emits
 * `window.breached` / `window.recovered`.
 *
 * Enabled watches are loaded per tracked_app with a short in-process cache so
 * the edge never hits the DB per request.
 */
import { eq, and } from 'drizzle-orm';
import type Redis from 'ioredis';
import { publishBoltEvent } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { blipWatches } from '../db/schema/blip-watches.js';
import { blipWatchEvents } from '../db/schema/blip-watch-events.js';
import { evalPredicate, type Predicate } from './predicate.js';
import type { TailEntry } from './broadcast.js';

type WatchRow = typeof blipWatches.$inferSelect;

const CACHE_TTL_MS = 15_000;
const cache = new Map<string, { at: number; rows: WatchRow[] }>();

async function loadEnabledWatches(trackedAppId: string, nowMs: number): Promise<WatchRow[]> {
  const cached = cache.get(trackedAppId);
  if (cached && nowMs - cached.at < CACHE_TTL_MS) return cached.rows;
  const rows = await db
    .select()
    .from(blipWatches)
    .where(and(eq(blipWatches.tracked_app_id, trackedAppId), eq(blipWatches.enabled, true)));
  cache.set(trackedAppId, { at: nowMs, rows });
  return rows;
}

/** Invalidate the in-process watch cache for a tracked app (after mutations). */
export function invalidateWatchCache(trackedAppId: string): void {
  cache.delete(trackedAppId);
}

export const windowReservoirKey = (watchId: string) => `blip:wwin:${watchId}`;

function appliesTo(watch: WatchRow, reportType: string): boolean {
  return watch.report_type == null || watch.report_type === reportType;
}

/**
 * Evaluate match watches and bump window reservoirs for one redacted entry.
 * Best-effort; never throws on the hot path.
 */
export async function evaluateWatches(
  redis: Redis,
  orgId: string,
  trackedAppId: string,
  reportType: string,
  entry: TailEntry,
  nowMs: number,
): Promise<void> {
  let watches: WatchRow[];
  try {
    watches = await loadEnabledWatches(trackedAppId, nowMs);
  } catch {
    return;
  }
  if (watches.length === 0) return;

  for (const w of watches) {
    if (!appliesTo(w, reportType)) continue;

    if (w.kind === 'match') {
      let matched = false;
      try {
        matched = evalPredicate(w.predicate as Predicate, entry);
      } catch {
        matched = false;
      }
      if (!matched) continue;
      // Cooldown: 0 = fire every match.
      if (w.cooldown_sec > 0) {
        try {
          const ok = await redis.set(`blip:wcd:${w.id}`, '1', 'EX', w.cooldown_sec, 'NX');
          if (ok !== 'OK') continue;
        } catch {
          // fall through and fire if cooldown bookkeeping fails
        }
      }
      void fireMatch(w, entry, orgId);
    } else if (w.kind === 'window') {
      // Reservoir bump: store value (numeric field if the aggregate names one).
      const pred = w.predicate as { aggregate?: { field?: string } };
      const field = pred.aggregate?.field;
      const num = field ? Number((entry.payload as Record<string, unknown>)[field] ?? entry.elapsed_ms) : 1;
      try {
        const member = `${nowMs}:${Math.random().toString(36).slice(2, 8)}:${Number.isFinite(num) ? num : ''}`;
        await redis.zadd(windowReservoirKey(w.id), nowMs, member);
        await redis.pexpire(windowReservoirKey(w.id), 600_000);
      } catch {
        // best-effort
      }
    }
  }
}

async function fireMatch(watch: WatchRow, entry: TailEntry, orgId: string): Promise<void> {
  const summary = {
    seq: entry.seq,
    received_at: entry.received_at,
    report_type: entry.report_type,
    level: entry.level,
    session_id: entry.session_id,
    app_version: entry.app_version,
    platform: entry.platform,
    elapsed_ms: entry.elapsed_ms,
    capture_count: entry.capture_count,
    payload: truncatePayload(entry.payload),
    deep_link: `/blip/apps/${watch.tracked_app_id}/types/${entry.report_type}`,
  };
  try {
    await publishBoltEvent(
      'entry.matched',
      'blip',
      {
        watch_id: watch.id,
        watch_name: watch.name,
        tracked_app_id: watch.tracked_app_id,
        report_type: entry.report_type,
        entry: summary,
      },
      orgId,
    );
    await db.insert(blipWatchEvents).values({
      org_id: orgId,
      watch_id: watch.id,
      tracked_app_id: watch.tracked_app_id,
      report_type: entry.report_type,
      event_name: 'entry.matched',
      context: summary,
    });
    await db
      .update(blipWatches)
      .set({ last_fired_at: new Date() })
      .where(eq(blipWatches.id, watch.id));
  } catch {
    // best-effort
  }
}

function truncatePayload(payload: Record<string, unknown>): Record<string, unknown> {
  const json = JSON.stringify(payload);
  if (json.length <= 2048) return payload;
  return { _truncated: true, preview: json.slice(0, 2048) };
}
