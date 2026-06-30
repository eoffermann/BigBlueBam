/**
 * Blip watch CRUD + ops (Blip §12, §15). A watch is a server-side condition that
 * emits a Bolt event when satisfied: a `match` watch reuses the §7.1 filter
 * predicate; a `window` watch holds a window/aggregate/comparator. The edge and
 * the blip-watch-eval worker do the firing; this service manages config, runs
 * dry-runs, and reads firing history. After every mutation we invalidate the
 * edge's in-process watch cache so it reloads. Every query is org-scoped.
 */
import { and, eq, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { blipWatches, blipWatchEvents } from '../db/schema/index.js';
import { invalidateWatchCache } from '../lib/watch-eval.js';
import { queryEntries } from './entry.service.js';
import { getApp } from './app.service.js';
import { NotFoundError, ValidationError } from './errors.js';
import type { Predicate } from '../lib/predicate.js';

const KINDS = new Set(['match', 'window']);

export interface CreateWatchInput {
  report_type?: string | null;
  name: string;
  description?: string | null;
  kind: string;
  predicate: unknown;
  cooldown_sec?: number;
}

export interface UpdateWatchInput {
  report_type?: string | null;
  name?: string;
  description?: string | null;
  kind?: string;
  predicate?: unknown;
  cooldown_sec?: number;
}

export async function createWatch(appId: string, orgId: string, userId: string, input: CreateWatchInput) {
  if (!KINDS.has(input.kind)) throw new ValidationError(`Invalid watch kind: ${input.kind}`);
  await getApp(appId, orgId);
  const rows = await db
    .insert(blipWatches)
    .values({
      org_id: orgId,
      tracked_app_id: appId,
      report_type: input.report_type ?? null,
      name: input.name,
      description: input.description ?? null,
      kind: input.kind,
      predicate: input.predicate,
      cooldown_sec: input.cooldown_sec ?? 60,
      created_by: userId,
    })
    .returning();
  invalidateWatchCache(appId);
  return rows[0]!;
}

export async function listWatches(appId: string, orgId: string) {
  await getApp(appId, orgId);
  return db
    .select()
    .from(blipWatches)
    .where(and(eq(blipWatches.tracked_app_id, appId), eq(blipWatches.org_id, orgId)))
    .orderBy(desc(blipWatches.created_at));
}

export async function getWatch(watchId: string, orgId: string) {
  const rows = await db
    .select()
    .from(blipWatches)
    .where(and(eq(blipWatches.id, watchId), eq(blipWatches.org_id, orgId)))
    .limit(1);
  if (rows.length === 0) throw new NotFoundError('Watch not found');
  return rows[0]!;
}

export async function updateWatch(watchId: string, orgId: string, input: UpdateWatchInput) {
  const existing = await getWatch(watchId, orgId);
  if (input.kind !== undefined && !KINDS.has(input.kind)) {
    throw new ValidationError(`Invalid watch kind: ${input.kind}`);
  }
  const patch: Record<string, unknown> = { updated_at: new Date() };
  if (input.report_type !== undefined) patch.report_type = input.report_type;
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.kind !== undefined) patch.kind = input.kind;
  if (input.predicate !== undefined) patch.predicate = input.predicate;
  if (input.cooldown_sec !== undefined) patch.cooldown_sec = input.cooldown_sec;
  const rows = await db
    .update(blipWatches)
    .set(patch)
    .where(and(eq(blipWatches.id, watchId), eq(blipWatches.org_id, orgId)))
    .returning();
  invalidateWatchCache(existing.tracked_app_id);
  return rows[0]!;
}

export async function setEnabled(watchId: string, orgId: string, enabled: boolean) {
  const existing = await getWatch(watchId, orgId);
  const rows = await db
    .update(blipWatches)
    .set({ enabled, updated_at: new Date() })
    .where(and(eq(blipWatches.id, watchId), eq(blipWatches.org_id, orgId)))
    .returning();
  invalidateWatchCache(existing.tracked_app_id);
  return rows[0]!;
}

export async function deleteWatch(watchId: string, orgId: string) {
  const existing = await getWatch(watchId, orgId);
  await db.delete(blipWatches).where(and(eq(blipWatches.id, watchId), eq(blipWatches.org_id, orgId)));
  invalidateWatchCache(existing.tracked_app_id);
  return { id: watchId, deleted: true };
}

export interface TestWatchInput {
  report_type: string;
  predicate: unknown;
  kind: string;
}

/**
 * Dry-run a watch condition. For `match`, evaluate the predicate over the most
 * recent entries (up to 50) and return the matches plus the sampled count. For
 * `window`, echo the parsed window/aggregate/comparator config without running.
 */
export async function testWatch(appId: string, orgId: string, input: TestWatchInput) {
  await getApp(appId, orgId);
  if (!KINDS.has(input.kind)) throw new ValidationError(`Invalid watch kind: ${input.kind}`);

  if (input.kind === 'window') {
    const pred = (input.predicate ?? {}) as Record<string, unknown>;
    return {
      kind: 'window' as const,
      window: {
        window_sec: pred.window_sec ?? null,
        aggregate: pred.aggregate ?? null,
        comparator: pred.comparator ?? null,
      },
    };
  }

  const result = await queryEntries({
    orgId,
    trackedAppId: appId,
    reportType: input.report_type,
    filter: input.predicate as Predicate | undefined,
    pageSize: 50,
  });
  return { would_match: result.rows, sampled: result.rows.length };
}

/** Recent firing log for a watch (newest first). */
export async function watchHistory(watchId: string, orgId: string, limit = 50) {
  await getWatch(watchId, orgId);
  return db
    .select()
    .from(blipWatchEvents)
    .where(and(eq(blipWatchEvents.watch_id, watchId), eq(blipWatchEvents.org_id, orgId)))
    .orderBy(desc(blipWatchEvents.fired_at))
    .limit(Math.min(Math.max(limit, 1), 200));
}
