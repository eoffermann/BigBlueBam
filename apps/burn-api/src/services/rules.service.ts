import { and, count, eq, sql } from 'drizzle-orm';
import type { BurnRuleCreate } from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import { burnAttributionRules, burnWorkItems } from '../db/schema/index.js';
import { NotFoundError, ValidationFailure } from '../lib/errors.js';
import { loadSettings } from './settings.service.js';
import type { Viewer } from './types.js';

/**
 * Attribution rules. Spec 2.3.3, and the reason they are owner/admin-only (spec 2.4 point 8).
 *
 * A rule is a member-reachable path that can NEUTRALIZE THE GATE. A rule matching everything
 * and attributing it to one large deliverable makes every subsequent charge "within
 * envelope" forever, and it does so without touching the gate settings, without an override,
 * and without leaving a precheck label. That is why `burn.rule.write` is a separate
 * permission at owner/admin tier rather than being folded into `burn.attribution.write`, and
 * why rules are on the no-MCP-tool list: rule authoring is human-only.
 *
 * Two independent guards on top of the permission:
 *   1. An EMPTY match is rejected by the shared Zod refinement AND by a DB CHECK. A rule with
 *      no discriminating key silently attributes the entire ledger.
 *   2. `match_ceiling_pct`: a rule that would match more than the configured share of the
 *      org's work items is rejected AT WRITE, and raises `rule_overreach` if it drifts there
 *      later. A rule can be narrow on the day it is written and broad six months on.
 */

export async function listRules(viewer: Viewer) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const rows = await tx
      .select()
      .from(burnAttributionRules)
      .where(eq(burnAttributionRules.organization_id, viewer.org_id))
      .orderBy(sql`${burnAttributionRules.priority} ASC`);
    return { data: rows };
  });
}

/**
 * The share of the org's work items a candidate rule would match.
 *
 * Deliberately estimated over the EXISTING corpus rather than reasoned about abstractly: a
 * match predicate that looks narrow ("source_types: [bam.task]") can be 90 percent of the
 * ledger in a firm that logs everything as tasks, and the only way to know is to count.
 */
async function estimateMatchPct(
  tx: Parameters<Parameters<typeof runInOrgScope>[1]>[0],
  orgId: string,
  match: Record<string, unknown>,
): Promise<number> {
  const [total] = await tx
    .select({ n: count() })
    .from(burnWorkItems)
    .where(eq(burnWorkItems.organization_id, orgId));
  const totalN = Number(total?.n ?? 0);
  if (totalN === 0) return 0;

  const conditions = [eq(burnWorkItems.organization_id, orgId)];
  const sourceTypes = match.source_types as string[] | undefined;
  if (sourceTypes?.length) {
    conditions.push(sql`${burnWorkItems.source_type} = ANY(${sourceTypes})` as never);
  }
  const projectIds = match.project_ids as string[] | undefined;
  if (projectIds?.length) {
    conditions.push(sql`${burnWorkItems.project_id} = ANY(${projectIds})` as never);
  }
  const actorIds = match.actor_ids as string[] | undefined;
  if (actorIds?.length) {
    conditions.push(sql`${burnWorkItems.actor_id} = ANY(${actorIds})` as never);
  }
  const titlePattern = match.title_pattern as string | undefined;
  if (titlePattern) {
    conditions.push(sql`${burnWorkItems.title_snapshot} ILIKE ${'%' + titlePattern + '%'}` as never);
  }

  const [matched] = await tx
    .select({ n: count() })
    .from(burnWorkItems)
    .where(and(...conditions));
  return (Number(matched?.n ?? 0) / totalN) * 100;
}

export async function createRule(viewer: Viewer, body: BurnRuleCreate) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const settings = await loadSettings(tx, viewer.org_id);
    const ceiling = Number(settings.match_ceiling_pct ?? 40);
    const pct = await estimateMatchPct(tx, viewer.org_id, body.match as Record<string, unknown>);
    if (pct > ceiling) {
      throw new ValidationFailure(
        `This rule would match ${pct.toFixed(1)} percent of the work-item corpus, above the configured ceiling of ${ceiling} percent. A rule that broad attributes the ledger wholesale and silently neutralizes the gate. Narrow the match.`,
        'RULE_MATCH_CEILING_EXCEEDED',
      );
    }
    const [created] = await tx
      .insert(burnAttributionRules)
      .values({
        organization_id: viewer.org_id,
        name: body.name,
        priority: body.priority,
        match: body.match,
        outcome_kind: body.outcome_kind,
        outcome_deliverable_id: body.outcome_deliverable_id ?? null,
        outcome_reason: body.outcome_reason ?? null,
        is_enabled: body.is_enabled,
        last_match_pct: String(pct.toFixed(2)),
        created_by: viewer.id,
      })
      .returning();
    return { data: created };
  });
}

export async function updateRule(viewer: Viewer, id: string, patch: Partial<BurnRuleCreate>) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const [existing] = await tx
      .select()
      .from(burnAttributionRules)
      .where(
        and(
          eq(burnAttributionRules.organization_id, viewer.org_id),
          eq(burnAttributionRules.id, id),
        ),
      )
      .limit(1);
    if (!existing) throw new NotFoundError('Rule not found');

    const values: Record<string, unknown> = { ...patch, updated_at: new Date() };
    if (patch.match) {
      const settings = await loadSettings(tx, viewer.org_id);
      const ceiling = Number(settings.match_ceiling_pct ?? 40);
      const pct = await estimateMatchPct(tx, viewer.org_id, patch.match as Record<string, unknown>);
      if (pct > ceiling) {
        throw new ValidationFailure(
          `This rule would match ${pct.toFixed(1)} percent of the work-item corpus, above the configured ceiling of ${ceiling} percent.`,
          'RULE_MATCH_CEILING_EXCEEDED',
        );
      }
      values.last_match_pct = String(pct.toFixed(2));
    }
    const [updated] = await tx
      .update(burnAttributionRules)
      .set(values)
      .where(eq(burnAttributionRules.id, id))
      .returning();
    return { data: updated };
  });
}

export async function deleteRule(viewer: Viewer, id: string) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const deleted = await tx
      .delete(burnAttributionRules)
      .where(
        and(
          eq(burnAttributionRules.organization_id, viewer.org_id),
          eq(burnAttributionRules.id, id),
        ),
      )
      .returning({ id: burnAttributionRules.id });
    if (deleted.length === 0) throw new NotFoundError('Rule not found');
    return { data: { id, deleted: true } };
  });
}
