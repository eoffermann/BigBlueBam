import { eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { benchMaterializedViews } from '../db/schema/index.js';
import { badRequest, notFound } from '../lib/utils.js';

/** Strict identifier: lowercase letters, digits, underscores. Max 63 chars (PG limit). */
const SAFE_IDENT = /^[a-z_][a-z0-9_]{0,62}$/;

function validateViewName(name: string): string {
  if (!SAFE_IDENT.test(name)) {
    throw badRequest(`Invalid materialized view name: ${name}`);
  }
  return name;
}

// ---------------------------------------------------------------------------
// List materialized views
// ---------------------------------------------------------------------------

export async function listMaterializedViews() {
  return db.select().from(benchMaterializedViews);
}

// ---------------------------------------------------------------------------
// Refresh a materialized view
// ---------------------------------------------------------------------------

/**
 * Refresh a bench materialized view and record the attempt outcome.
 *
 * On entry, marks the row as in_progress with last_refresh_attempt_at = now.
 * On success, sets last_refresh_status = success, updates last_refreshed_at,
 * refresh_duration_ms, and clears last_refresh_error. On failure, sets
 * last_refresh_status = failed and captures the error message. Worker code
 * owns computing next_scheduled_at from refresh_cron after calling this.
 * See migration 0085 and Bench_Plan.md G3.
 */
export async function refreshView(viewName: string) {
  const safeName = validateViewName(viewName);

  const [view] = await db
    .select()
    .from(benchMaterializedViews)
    .where(eq(benchMaterializedViews.view_name, safeName))
    .limit(1);

  if (!view) throw notFound(`Materialized view not found: ${safeName}`);

  const attemptStart = new Date();
  await db
    .update(benchMaterializedViews)
    .set({
      last_refresh_attempt_at: attemptStart,
      last_refresh_status: 'in_progress',
      last_refresh_error: null,
    })
    .where(eq(benchMaterializedViews.view_name, safeName));

  const start = Date.now();
  try {
    try {
      await db.execute(sql.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${safeName}`));
    } catch {
      // CONCURRENTLY requires a unique index; fall back to non-concurrent
      await db.execute(sql.raw(`REFRESH MATERIALIZED VIEW ${safeName}`));
    }
    const durationMs = Date.now() - start;
    const refreshedAt = new Date();

    await db
      .update(benchMaterializedViews)
      .set({
        last_refreshed_at: refreshedAt,
        refresh_duration_ms: durationMs,
        last_refresh_status: 'success',
        last_refresh_error: null,
      })
      .where(eq(benchMaterializedViews.view_name, safeName));

    return {
      view_name: safeName,
      duration_ms: durationMs,
      refreshed_at: refreshedAt.toISOString(),
      status: 'success' as const,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(benchMaterializedViews)
      .set({
        refresh_duration_ms: durationMs,
        last_refresh_status: 'failed',
        last_refresh_error: message,
      })
      .where(eq(benchMaterializedViews.view_name, safeName));
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Update next scheduled refresh time (called by worker after computing cron)
// ---------------------------------------------------------------------------

export async function setNextScheduledAt(viewName: string, nextAt: Date | null) {
  const safeName = validateViewName(viewName);
  await db
    .update(benchMaterializedViews)
    .set({ next_scheduled_at: nextAt })
    .where(eq(benchMaterializedViews.view_name, safeName));
}

// ---------------------------------------------------------------------------
// List views due for refresh (used by worker scheduler tick)
// ---------------------------------------------------------------------------

export async function listDueViews(now: Date = new Date()) {
  return db
    .select()
    .from(benchMaterializedViews)
    .where(sql`${benchMaterializedViews.next_scheduled_at} <= ${now.toISOString()}::timestamptz`);
}
