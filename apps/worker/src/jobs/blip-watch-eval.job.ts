/**
 * Blip window-watch evaluation tick (Blip §12.1).
 *
 * Match watches fire on the edge (apps/blip-api/src/lib/watch-eval.ts). Window
 * watches are aggregate-over-a-sliding-window conditions: the edge only bumps a
 * lightweight per-watch Redis reservoir (ZSET `blip:wwin:<watch_id>`, scored by
 * epoch-ms, member encoded `<ms>:<rand>:<value>`). This worker tick (default
 * every 30s) reads each enabled window watch's reservoir over its window_sec,
 * computes the aggregate, compares to the comparator, and maintains a breach
 * state machine in Redis (`blip:wstate:<watch_id>`):
 *
 *   - upward crossing (not breached -> breaching): emit window.breached
 *   - return below   (breached -> clear):          emit window.recovered
 *
 * The state machine itself is the anti-flap (one event per transition); a
 * per-watch cooldown additionally throttles repeated breach/recover churn.
 * Old reservoir entries are trimmed each tick (ZREMRANGEBYSCORE).
 */

import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type Redis from 'ioredis';
import { sql } from 'drizzle-orm';
import { publishBoltEvent } from '@bigbluebam/shared';
import { getDb } from '../utils/db.js';

export interface BlipWatchEvalJobData {
  _tick?: boolean;
}

interface WatchRow {
  id: string;
  org_id: string;
  tracked_app_id: string;
  report_type: string | null;
  name: string;
  predicate: {
    window_sec?: number;
    aggregate?: { op: string; field?: string };
    comparator?: { operator: 'gt' | 'gte' | 'lt' | 'lte'; value: number };
  };
  cooldown_sec: number;
}

const reservoirKey = (watchId: string) => `blip:wwin:${watchId}`;
const stateKey = (watchId: string) => `blip:wstate:${watchId}`;
const cooldownKey = (watchId: string) => `blip:wcd:${watchId}`;

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

/** Decode the numeric value from a `<ms>:<rand>:<value>` reservoir member. */
function memberValue(member: string): number | null {
  const idx = member.lastIndexOf(':');
  if (idx < 0) return null;
  const raw = member.slice(idx + 1);
  if (raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loV = sorted[lo] ?? 0;
  const hiV = sorted[hi] ?? 0;
  if (lo === hi) return loV;
  return loV + (hiV - loV) * (rank - lo);
}

function aggregate(op: string, values: number[], count: number, windowSec: number): number {
  switch (op) {
    case 'count':
      return count;
    case 'rate':
      return windowSec > 0 ? count / windowSec : count;
    case 'avg':
      return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
    case 'min':
      return values.length ? Math.min(...values) : 0;
    case 'max':
      return values.length ? Math.max(...values) : 0;
    case 'p50':
      return percentile([...values].sort((a, b) => a - b), 50);
    case 'p95':
      return percentile([...values].sort((a, b) => a - b), 95);
    case 'p99':
      return percentile([...values].sort((a, b) => a - b), 99);
    default:
      return count;
  }
}

function compare(value: number, op: string, threshold: number): boolean {
  switch (op) {
    case 'gt':
      return value > threshold;
    case 'gte':
      return value >= threshold;
    case 'lt':
      return value < threshold;
    case 'lte':
      return value <= threshold;
    default:
      return false;
  }
}

export async function processBlipWatchEvalJob(
  _job: Job<BlipWatchEvalJobData>,
  redis: Redis,
  logger: Logger,
): Promise<void> {
  const db = getDb();

  const watches = rows<WatchRow>(
    await db.execute(sql`
      SELECT id, org_id, tracked_app_id, report_type, name, predicate, cooldown_sec
      FROM blip_watches
      WHERE enabled = true AND kind = 'window'
    `),
  );
  if (watches.length === 0) return;

  const now = Date.now();
  let breached = 0;
  let recovered = 0;

  for (const w of watches) {
    const pred = w.predicate ?? {};
    const windowSec = Number(pred.window_sec) > 0 ? Number(pred.window_sec) : 60;
    const op = pred.aggregate?.op ?? 'count';
    const comparator = pred.comparator;
    if (!comparator) continue;

    const cutoff = now - windowSec * 1000;
    const key = reservoirKey(w.id);

    let members: string[];
    try {
      members = await redis.zrangebyscore(key, cutoff, '+inf');
    } catch {
      continue;
    }

    const values: number[] = [];
    for (const m of members) {
      const v = memberValue(m);
      if (v != null) values.push(v);
    }
    const value = aggregate(op, values, members.length, windowSec);
    const breaching = compare(value, comparator.operator, comparator.value);

    let prevState: string | null = null;
    try {
      prevState = await redis.get(stateKey(w.id));
    } catch {
      prevState = null;
    }
    const wasBreached = prevState === '1';

    if (breaching && !wasBreached) {
      // Cooldown throttles breach/recover churn.
      if (w.cooldown_sec > 0) {
        try {
          const ok = await redis.set(cooldownKey(w.id), '1', 'EX', w.cooldown_sec, 'NX');
          if (ok !== 'OK') {
            // Still in cooldown; record the state so we don't recover spuriously.
            await redis.set(stateKey(w.id), '1');
            continue;
          }
        } catch {
          /* fire anyway if cooldown bookkeeping fails */
        }
      }
      await emitWindowEvent(db, w, 'window.breached', value, comparator.value, windowSec, members.length);
      try {
        await redis.set(stateKey(w.id), '1');
      } catch {
        /* best-effort */
      }
      breached += 1;
    } else if (!breaching && wasBreached) {
      await emitWindowEvent(db, w, 'window.recovered', value, comparator.value, windowSec, members.length);
      try {
        await redis.del(stateKey(w.id));
      } catch {
        /* best-effort */
      }
      recovered += 1;
    }

    // Trim reservoir entries older than the window (keep the window live).
    try {
      await redis.zremrangebyscore(key, '-inf', `(${cutoff}`);
    } catch {
      /* best-effort */
    }
  }

  if (breached > 0 || recovered > 0) {
    logger.info({ breached, recovered, watches: watches.length }, 'blip-watch-eval: tick');
  }
}

async function emitWindowEvent(
  db: ReturnType<typeof getDb>,
  w: WatchRow,
  eventName: 'window.breached' | 'window.recovered',
  value: number,
  threshold: number,
  windowSec: number,
  sampleCount: number,
): Promise<void> {
  const context = { value, threshold, window_sec: windowSec, sample_count: sampleCount };
  try {
    await publishBoltEvent(
      eventName,
      'blip',
      {
        watch_id: w.id,
        watch_name: w.name,
        tracked_app_id: w.tracked_app_id,
        report_type: w.report_type,
        ...context,
      },
      w.org_id,
    );
    await db.execute(sql`
      INSERT INTO blip_watch_events
        (org_id, watch_id, tracked_app_id, report_type, event_name, context)
      VALUES
        (${w.org_id}, ${w.id}, ${w.tracked_app_id}, ${w.report_type},
         ${eventName}, ${JSON.stringify(context)}::jsonb)
    `);
    if (eventName === 'window.breached') {
      await db.execute(sql`
        UPDATE blip_watches SET last_fired_at = NOW() WHERE id = ${w.id}
      `);
    }
  } catch {
    /* best-effort: an alert that fails to log must not wedge the tick */
  }
}
