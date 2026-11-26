// The deterministic compile (spec 2.1 step 5; rows 9-10 of 5.1). M3 has no LLM: the library's
// suggestions are proposed verbatim and each population is proposed from the connected set. The
// run is recorded in bastion_compile_runs (used_fallback = true) and everything lands as
// `proposed` for a person to confirm. The run is short (pure planning plus one insert), so it
// completes inside the request; the route still answers 202 with the run, and M7 moves the
// LLM-tailored compile onto the worker behind the same contract.

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { runInOrgScope } from '../plugins/rls.js';
import {
  bastionAssertions,
  bastionCompileRuns,
  bastionControlRequirements,
  bastionControls,
  bastionFrameworks,
} from '../db/schema/index.js';
import { ConflictError } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { planCompile } from '../library/compile-plan.js';
import { derivedApplicability } from '../library/setup-state.js';
import { connectedPopulations, isUniqueViolation, loadFramework } from './shared.js';
import type { Viewer } from './types.js';

export async function compileFramework(viewer: Viewer, frameworkId: string) {
  // 1. Claim the run in its own transaction: the partial unique index allows one queued or
  //    running compile per framework, so a double click gets a plain 409.
  const run = await runInOrgScope(viewer.org_id, async (tx) => {
    const f = await loadFramework(tx, viewer.org_id, frameworkId);
    if (f.status === 'archived') throw new ConflictError('This framework is archived.', 'FRAMEWORK_ARCHIVED');
    try {
      const [r] = await tx
        .insert(bastionCompileRuns)
        .values({
          organization_id: viewer.org_id,
          framework_id: frameworkId,
          status: 'running',
          used_fallback: true,
          claimed_by: 'bastion-api:inline',
          heartbeat_at: new Date(),
          started_by: viewer.id,
          started_at: new Date(),
        })
        .returning();
      return r!;
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ConflictError('A setup run is already going for this framework.', 'COMPILE_RUNNING');
      }
      throw err;
    }
  });

  try {
    // 2. Plan and insert in one transaction; mark the run succeeded in the same one.
    return await runInOrgScope(viewer.org_id, async (tx) => {
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
          control_key: keyById.get(e.control_id)!,
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
            control_id: idByKey.get(p.control_key)!,
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
      const [done] = await tx
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
        .returning();
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
      return { data: done! };
    });
  } catch (err) {
    // 3. Never leave a run claimed: a failed plan marks the run failed so a retry can start.
    await runInOrgScope(viewer.org_id, (tx) =>
      tx
        .update(bastionCompileRuns)
        .set({ status: 'failed', error: (err as Error).message.slice(0, 2000), completed_at: new Date() })
        .where(and(eq(bastionCompileRuns.id, run.id), isNull(bastionCompileRuns.completed_at))),
    ).catch(() => {});
    throw err;
  }
}

export async function listCompileRuns(viewer: Viewer, frameworkId: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    await loadFramework(tx, viewer.org_id, frameworkId);
    const rows = await tx
      .select()
      .from(bastionCompileRuns)
      .where(and(eq(bastionCompileRuns.organization_id, viewer.org_id), eq(bastionCompileRuns.framework_id, frameworkId)))
      .orderBy(desc(bastionCompileRuns.created_at))
      .limit(50);
    return { data: rows, next_cursor: null };
  });
}
