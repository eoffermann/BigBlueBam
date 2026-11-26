// The deterministic compile (spec 2.1 step 5; rows 9-10 of 5.1). M3 has no LLM: the library's
// suggestions are proposed verbatim and each population is proposed from the connected set. The
// run is recorded in bastion_compile_runs (used_fallback = true) and everything lands as
// `proposed` for a person to confirm. The run is short (pure planning plus one insert), so it
// completes inside the request; the route still answers 202 with the run, and M7 moves the
// LLM-tailored compile onto the worker behind the same contract.
//
// Atomicity (issue #193): the claim, the plan, the inserts and the `succeeded` update are ONE
// transaction. The partial unique index idx_bastion_compile_runs_one_active still serializes a
// double click (the second insert waits on the first's uncommitted key, then gets 23505 and a
// plain 409), and a crash, restart or pool timeout rolls the claim back with everything else, so
// an inline run can never be left `running` with nobody behind it. A committed inline claim can
// only come from a build before this fix (or a request that held one across a deploy); the next
// compile treats it as stale once its heartbeat is older than INLINE_RUN_LEASE_MS, marks it
// `failed` and proceeds. The M4 reaper must likewise mark `bastion-api:inline` runs `failed`,
// never `queued` (no worker resumes an inline run).

import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { createLogger } from '@bigbluebam/logging';
import { runInOrgScope } from '../plugins/rls.js';
import type { DbTx } from '../db/index.js';
import {
  bastionAssertions,
  bastionCompileRuns,
  bastionControlRequirements,
  bastionControls,
  bastionFrameworks,
} from '../db/schema/index.js';
import { ConflictError, NotFoundError, ValidationFailure, one } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { planCompile } from '../library/compile-plan.js';
import { derivedApplicability } from '../library/setup-state.js';
import { connectedPopulations, isUniqueViolation, loadFramework } from './shared.js';
import type { Viewer } from './types.js';

/** The claim an inline (in-request) compile records. No worker ever resumes such a run. */
export const INLINE_COMPILE_CLAIM = 'bastion-api:inline';
/** A committed inline claim whose heartbeat is older than this is stale (its request is gone). */
export const INLINE_RUN_LEASE_MS = 2 * 60 * 1000;

const STALE_RUN_MESSAGE =
  'This setup run stopped before it finished (the server restarted or lost its connection), so it was released.';

/** Where a failure that cannot be recorded is reported. Routes pass the request logger. */
export interface CompileLogger {
  warn(obj: Record<string, unknown>, msg: string): void;
}

let fallbackLogger: CompileLogger | null = null;
function defaultLogger(): CompileLogger {
  if (!fallbackLogger) fallbackLogger = createLogger({ service: 'bastion-api' });
  return fallbackLogger;
}

/**
 * Release committed inline claims on this framework whose heartbeat is older than the lease:
 * they belong to a request that no longer exists. Marked `failed` (never `queued`: nothing would
 * resume them). Returns how many were released.
 */
async function releaseStaleInlineRuns(tx: DbTx, orgId: string, frameworkId: string): Promise<number> {
  const cutoff = new Date(Date.now() - INLINE_RUN_LEASE_MS);
  const released = await tx
    .update(bastionCompileRuns)
    .set({ status: 'failed', error: STALE_RUN_MESSAGE, completed_at: new Date() })
    .where(
      and(
        eq(bastionCompileRuns.organization_id, orgId),
        eq(bastionCompileRuns.framework_id, frameworkId),
        eq(bastionCompileRuns.claimed_by, INLINE_COMPILE_CLAIM),
        inArray(bastionCompileRuns.status, ['queued', 'running']),
        or(isNull(bastionCompileRuns.heartbeat_at), lt(bastionCompileRuns.heartbeat_at, cutoff)),
      ),
    )
    .returning({ id: bastionCompileRuns.id });
  return released.length;
}

/**
 * Record a compile that failed after it started, in its own transaction (the compile's own
 * transaction rolled back, taking its claim with it), so the run history stays honest. A failure
 * to record is logged, never swallowed silently; it does not mask the original error.
 */
async function recordFailedRun(viewer: Viewer, frameworkId: string, cause: unknown, log: CompileLogger) {
  try {
    await runInOrgScope(viewer.org_id, (tx) =>
      tx.insert(bastionCompileRuns).values({
        organization_id: viewer.org_id,
        framework_id: frameworkId,
        status: 'failed',
        used_fallback: true,
        claimed_by: INLINE_COMPILE_CLAIM,
        error: String((cause as Error)?.message ?? cause).slice(0, 2000),
        started_by: viewer.id,
        started_at: new Date(),
        heartbeat_at: new Date(),
        completed_at: new Date(),
      }),
    );
  } catch (recordErr) {
    log.warn(
      {
        err: recordErr,
        cause: (cause as Error)?.message ?? String(cause),
        framework_id: frameworkId,
        organization_id: viewer.org_id,
      },
      'bastion compile failed and the failed run could not be recorded',
    );
  }
}

export async function compileFramework(viewer: Viewer, frameworkId: string, log: CompileLogger = defaultLogger()) {
  try {
    return await compileInOneTransaction(viewer, frameworkId);
  } catch (err) {
    // A refusal (not found, archived, already running, bad input) started nothing: nothing to record.
    if (err instanceof ConflictError || err instanceof NotFoundError || err instanceof ValidationFailure) throw err;
    await recordFailedRun(viewer, frameworkId, err, log);
    throw err;
  }
}

async function compileInOneTransaction(viewer: Viewer, frameworkId: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const f = await loadFramework(tx, viewer.org_id, frameworkId);
    if (f.status === 'archived') throw new ConflictError('This framework is archived.', 'FRAMEWORK_ARCHIVED');
    await releaseStaleInlineRuns(tx, viewer.org_id, frameworkId);

    // Claim. A unique violation (another compile holds the one active slot) is a plain 409; the
    // throw rolls this transaction back.
    let run: typeof bastionCompileRuns.$inferSelect;
    try {
      run = one(
        await tx
          .insert(bastionCompileRuns)
          .values({
            organization_id: viewer.org_id,
            framework_id: frameworkId,
            status: 'running',
            used_fallback: true,
            claimed_by: INLINE_COMPILE_CLAIM,
            heartbeat_at: new Date(),
            started_by: viewer.id,
            started_at: new Date(),
          })
          .returning(),
        'compile run',
      );
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('A setup run is already going for this framework.', 'COMPILE_RUNNING');
      }
      throw err;
    }

    // Plan, insert and mark the run succeeded in the same transaction.
    {
      const links = await tx
        .select({
          control_id: bastionControlRequirements.control_id,
          framework_id: bastionControlRequirements.framework_id,
          applicability: bastionControlRequirements.applicability,
          removed_at: bastionControlRequirements.removed_at,
        })
        .from(bastionControlRequirements)
        .where(eq(bastionControlRequirements.organization_id, viewer.org_id));
      const inFramework = new Set(
        links.filter((l) => l.framework_id === frameworkId && !l.removed_at).map((l) => l.control_id),
      );
      const controls = (
        await tx
          .select({ id: bastionControls.id, control_key: bastionControls.control_key, lifecycle: bastionControls.lifecycle })
          .from(bastionControls)
          .where(eq(bastionControls.organization_id, viewer.org_id))
      ).filter(
        (c) =>
          c.lifecycle === 'active' &&
          inFramework.has(c.id) &&
          // A control excluded everywhere is not evaluated (spec 2.1), so it gets no proposals.
          derivedApplicability(links.filter((l) => l.control_id === c.id)) === 'applicable',
      );
      const idByKey = new Map(controls.map((c) => [c.control_key, c.id]));
      const keyById = new Map(controls.map((c) => [c.id, c.control_key]));
      const existing = controls.length
        ? await tx
            .select({
              control_id: bastionAssertions.control_id,
              kind: bastionAssertions.kind,
              probe_key: bastionAssertions.probe_key,
              manual_evidence_spec: bastionAssertions.manual_evidence_spec,
              review_status: bastionAssertions.review_status,
            })
            .from(bastionAssertions)
            .where(
              and(
                eq(bastionAssertions.organization_id, viewer.org_id),
                inArray(
                  bastionAssertions.control_id,
                  controls.map((c) => c.id),
                ),
              ),
            )
        : [];
      const plan = planCompile(
        controls.map((c) => c.control_key),
        existing.map((e) => ({
          control_key: (keyById.get(e.control_id) as string),
          kind: e.kind,
          probe_key: e.probe_key,
          manual_title: (e.manual_evidence_spec as { title?: string } | null)?.title ?? null,
          review_status: e.review_status,
        })),
        await connectedPopulations(tx, viewer.org_id),
      );
      if (plan.planned.length > 0) {
        await tx.insert(bastionAssertions).values(
          plan.planned.map((p) => ({
            organization_id: viewer.org_id,
            control_id: (idByKey.get(p.control_key) as string),
            kind: p.kind,
            probe_key: p.probe_key,
            probe_version: p.probe_version,
            params: p.params,
            predicate: p.predicate,
            manual_evidence_spec: p.manual_evidence_spec,
            plain_statement: p.plain_statement,
            proposed_by: 'library',
            compile_run_id: run.id,
            review_status: 'proposed',
            created_by: viewer.id,
          })),
        );
      }
      const done = one(await tx
        .update(bastionCompileRuns)
        .set({
          status: 'succeeded',
          controls_total: plan.controls_total,
          controls_done: plan.controls_total,
          assertions_proposed: plan.planned.length,
          assertions_dropped: plan.dropped.length,
          drop_reasons: { items: plan.dropped, skipped_existing: plan.skipped_existing },
          heartbeat_at: new Date(),
          completed_at: new Date(),
        })
        .where(and(eq(bastionCompileRuns.id, run.id), eq(bastionCompileRuns.organization_id, viewer.org_id)))
        .returning(), 'done');
      await tx
        .update(bastionFrameworks)
        .set({ status: 'active' })
        .where(
          and(
            eq(bastionFrameworks.id, frameworkId),
            eq(bastionFrameworks.organization_id, viewer.org_id),
            eq(bastionFrameworks.status, 'compiling'),
          ),
        );
      await audit(tx, viewer, 'framework.compile', { type: 'compile_run', id: run.id }, {
        framework_id: frameworkId,
        assertions_proposed: plan.planned.length,
        assertions_dropped: plan.dropped.length,
        used_fallback: true,
      });
      return { data: done };
    }
  });
}

/* ------------------------------ Run history ------------------------------ */

export const COMPILE_RUNS_DEFAULT_LIMIT = 50;
export const COMPILE_RUNS_MAX_LIMIT = 200;

/**
 * Opaque keyset cursor: the last row's id. The page boundary is read back from the row itself
 * (`(created_at, id) < (SELECT created_at, id ...)`), so microsecond timestamps never lose
 * precision through JavaScript.
 */
export function encodeRunCursor(row: { id: string }): string {
  return Buffer.from(row.id, 'utf8').toString('base64url');
}

export function decodeRunCursor(cursor: string): string {
  try {
    const id = Buffer.from(cursor, 'base64url').toString('utf8');
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) throw new Error('bad');
    return id;
  } catch {
    throw new ValidationFailure('That page link is no longer valid. Start from the first page.', 'INVALID_CURSOR', [
      { field: 'cursor', issue: 'invalid' },
    ]);
  }
}

/**
 * GET /frameworks/:id/compile-runs, newest first, cursor-paginated (issue #193: the list used to
 * stop at 50 while claiming to be complete). `next_cursor` is null only on the last page.
 */
export async function listCompileRuns(viewer: Viewer, frameworkId: string, query: { cursor?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(query.limit ?? COMPILE_RUNS_DEFAULT_LIMIT, 1), COMPILE_RUNS_MAX_LIMIT);
  const after = query.cursor ? decodeRunCursor(query.cursor) : null;
  return runInOrgScope(viewer.org_id, async (tx) => {
    await loadFramework(tx, viewer.org_id, frameworkId);
    const rows = await tx
      .select()
      .from(bastionCompileRuns)
      .where(
        and(
          eq(bastionCompileRuns.organization_id, viewer.org_id),
          eq(bastionCompileRuns.framework_id, frameworkId),
          after
            ? sql`(${bastionCompileRuns.created_at}, ${bastionCompileRuns.id}) < (
                SELECT c.created_at, c.id FROM bastion_compile_runs c
                 WHERE c.id = ${after}::uuid AND c.organization_id = ${viewer.org_id}::uuid
              )`
            : undefined,
        ),
      )
      .orderBy(desc(bastionCompileRuns.created_at), desc(bastionCompileRuns.id))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    const has_more = rows.length > limit;
    return { data: page, has_more, next_cursor: has_more && last ? encodeRunCursor(last) : null };
  });
}
