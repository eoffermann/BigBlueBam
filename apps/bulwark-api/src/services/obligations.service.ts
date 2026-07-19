import { and, eq, sql, type SQL } from 'drizzle-orm';
import {
  bulwarkDeadlineRuleSchema,
  bulwarkEventBindingSchema,
  calendarArmKey,
  manualArmKey,
  type BulwarkPatchObligationInput,
  type BulwarkDeadlineRule,
  type BulwarkEventBinding,
} from '@bigbluebam/shared';
import { db } from '../db/index.js';
import {
  bulwarkContracts,
  bulwarkObligations,
  bulwarkNoticeDeadlines,
} from '../db/schema/index.js';
import { decodeCursor, encodeCursor, keysetOrder, keysetPredicate } from '../lib/pagination.js';
import { memberProjectIds } from '../lib/project-scope.js';
import { isAdminViewer, type Viewer } from './types.js';
import { NotFoundError, ProjectScopeError, ValidationFailure } from '../lib/errors.js';
import { loadScopedContract } from './contracts.service.js';
import { computeDueAt, anchorDateInZone } from './deadline-math.service.js';
import { armDeadline } from './arming.service.js';

type ObligationRow = typeof bulwarkObligations.$inferSelect;

function parseBinding(raw: unknown): BulwarkEventBinding | null {
  const r = bulwarkEventBindingSchema.safeParse(raw);
  return r.success ? r.data : null;
}
function parseRule(raw: unknown): BulwarkDeadlineRule | null {
  const r = bulwarkDeadlineRuleSchema.safeParse(raw);
  return r.success ? r.data : null;
}

// The D5 auto-arm gate reconciled to the real enum. A confirmed obligation is armable when:
//  - event-bound: it carries a non-empty entity_filter AND the contract has a project_id
//    (STJ5 - firing needs a scope to fail closed on);
//  - calendar-derived (from != trigger_event): armable so the radar can arm it;
//  - unbound + trigger_event: NOT event/calendar-armable (manual-trigger only), is_armed false.
function computeIsArmed(
  reviewStatus: string,
  binding: BulwarkEventBinding | null,
  rule: BulwarkDeadlineRule | null,
  contractProjectId: string | null,
): boolean {
  if (reviewStatus !== 'confirmed' && reviewStatus !== 'auto_confirmed') return false;
  const from = rule?.from ?? 'trigger_event';
  if (from !== 'trigger_event') return true; // calendar-derived; radar arms it
  if (!binding || binding.unbound) return false; // manual-trigger only
  const filter = binding.entity_filter;
  if (!filter || !filter.payload_path || !filter.equals_contract_field) return false; // STJ5
  if (contractProjectId === null) return false;
  return true;
}

// ── Project-scoping predicate for obligation lists/detail (via the parent contract). ──
async function obligationScope(viewer: Viewer): Promise<SQL | undefined> {
  const orgPred = eq(bulwarkObligations.organization_id, viewer.org_id);
  if (isAdminViewer(viewer)) return orgPred;
  const ids = await memberProjectIds(viewer.id);
  // project_id IN member OR project_id IS NULL (SK3 org fallback), joined via contract.
  const projPred =
    ids.length === 0
      ? sql`${bulwarkContracts.project_id} IS NULL`
      : sql`(${bulwarkContracts.project_id} IS NULL OR ${bulwarkContracts.project_id} IN ${ids})`;
  return and(orgPred, projPred);
}

export interface ListObligationsOpts {
  cursor?: string;
  limit: number;
  reviewStatus?: string;
  obligationType?: string;
  contractId?: string;
  sortByConfidenceDesc?: boolean;
}

export async function listObligations(viewer: Viewer, opts: ListObligationsOpts) {
  const scope = await obligationScope(viewer);
  const cursor = decodeCursor(opts.cursor);
  const conds: (SQL | undefined)[] = [
    scope,
    keysetPredicate(bulwarkObligations.created_at, bulwarkObligations.id, cursor),
  ];
  if (opts.reviewStatus) conds.push(eq(bulwarkObligations.review_status, opts.reviewStatus));
  if (opts.obligationType) conds.push(eq(bulwarkObligations.obligation_type, opts.obligationType));
  if (opts.contractId) conds.push(eq(bulwarkObligations.contract_id, opts.contractId));

  const rows = await db
    .select({ o: bulwarkObligations })
    .from(bulwarkObligations)
    .innerJoin(bulwarkContracts, eq(bulwarkContracts.id, bulwarkObligations.contract_id))
    .where(and(...conds.filter(Boolean).map((c) => c as SQL)))
    .orderBy(...keysetOrder(bulwarkObligations.created_at, bulwarkObligations.id))
    .limit(opts.limit + 1);

  const flat = rows.map((r) => r.o);
  const hasMore = flat.length > opts.limit;
  const page = hasMore ? flat.slice(0, opts.limit) : flat;
  const last = page[page.length - 1];
  return {
    data: page,
    next_cursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
  };
}

// Load an obligation with its contract, applying the project-scope guard. Throws NotFound
// when absent or the viewer cannot see the owning project.
export async function loadScopedObligation(
  viewer: Viewer,
  id: string,
): Promise<{ obligation: ObligationRow; contract: typeof bulwarkContracts.$inferSelect }> {
  const [row] = await db
    .select({ o: bulwarkObligations, c: bulwarkContracts })
    .from(bulwarkObligations)
    .innerJoin(bulwarkContracts, eq(bulwarkContracts.id, bulwarkObligations.contract_id))
    .where(
      and(eq(bulwarkObligations.organization_id, viewer.org_id), eq(bulwarkObligations.id, id)),
    )
    .limit(1);
  if (!row) throw new NotFoundError('Obligation not found');
  // Reuse the contract guard (handles admin override + null-project fallback + membership).
  await loadScopedContract(viewer, row.c.id);
  return { obligation: row.o, contract: row.c };
}

export async function getObligation(viewer: Viewer, id: string): Promise<ObligationRow> {
  const { obligation } = await loadScopedObligation(viewer, id);
  return obligation;
}

// Confirm / edit / bind-to-base / reject (spec 5.1 PATCH /obligations/:id). Applies the D5
// arm gate on confirm and drives supersession when supersedes_obligation_id + an outcome are
// supplied.
export async function patchObligation(
  viewer: Viewer,
  id: string,
  input: BulwarkPatchObligationInput,
): Promise<ObligationRow> {
  const { obligation, contract } = await loadScopedObligation(viewer, id);

  const patch: Record<string, unknown> = { updated_at: new Date() };
  if (input.title !== undefined) patch.title = input.title;
  if (input.obligation_type !== undefined) patch.obligation_type = input.obligation_type;
  if (input.event_binding !== undefined) patch.event_binding = input.event_binding;
  if (input.deadline_rule !== undefined) patch.deadline_rule = input.deadline_rule;
  if (input.mandated_doc_types !== undefined) patch.mandated_doc_types = input.mandated_doc_types;
  if (input.supersedes_obligation_id !== undefined)
    patch.supersedes_obligation_id = input.supersedes_obligation_id;

  const effectiveBinding = parseBinding(input.event_binding ?? obligation.event_binding);
  const effectiveRule = parseRule(input.deadline_rule ?? obligation.deadline_rule);

  if (input.review_status === 'rejected') {
    // Destructive: the confirm token is enforced at the MCP tool layer; at the REST layer a
    // light confirm flag prevents an accidental reject.
    if (input.confirm !== true)
      throw new ValidationFailure('Rejecting an obligation requires confirm=true', 'CONFIRM_REQUIRED');
    patch.review_status = 'rejected';
    patch.is_armed = false;
    patch.reviewed_by = viewer.id;
    patch.reviewed_at = new Date();
  } else if (input.review_status === 'confirmed') {
    // DK4: a recurrence with both `until` and contract.expiry_date null is rejected at confirm.
    if (
      effectiveRule?.recurrence &&
      effectiveRule.recurrence.until === null &&
      contract.expiry_date === null
    ) {
      throw new ValidationFailure(
        'An unbounded recurrence (recurrence.until null) requires the contract to have an expiry_date',
        'UNBOUNDED_RECURRENCE',
      );
    }
    // A human confirm here IS the required human action for the claim-waiving set (D5), so on
    // confirm any type may arm once its binding is complete (computeIsArmed gate).
    patch.review_status = 'confirmed';
    patch.reviewed_by = viewer.id;
    patch.reviewed_at = new Date();
    patch.is_armed = computeIsArmed(
      'confirmed',
      effectiveBinding,
      effectiveRule,
      contract.project_id,
    );
  }

  const [updated] = await db
    .update(bulwarkObligations)
    .set(patch)
    .where(
      and(eq(bulwarkObligations.organization_id, viewer.org_id), eq(bulwarkObligations.id, id)),
    )
    .returning();

  // Supersession (spec 4.1 amendment/DI3): retire the base and re-point/void its clocks.
  if (input.supersedes_obligation_id && input.supersession_outcome) {
    await applySupersession(
      viewer.org_id,
      input.supersedes_obligation_id,
      updated as ObligationRow,
      input.supersession_outcome,
      null,
    );
  }

  return updated as ObligationRow;
}

// Restate or terminate a base obligation superseded by a successor (spec 4.1 / STJ4 / DK4).
async function applySupersession(
  orgId: string,
  baseObligationId: string,
  successor: ObligationRow,
  outcome: 'restate' | 'terminate',
  reason: string | null,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [base] = await tx
      .select()
      .from(bulwarkObligations)
      .where(
        and(
          eq(bulwarkObligations.organization_id, orgId),
          eq(bulwarkObligations.id, baseObligationId),
        ),
      )
      .limit(1);
    if (!base) throw new NotFoundError('Base obligation not found');

    await tx
      .update(bulwarkObligations)
      .set({ review_status: 'superseded', is_armed: false, updated_at: new Date() })
      .where(eq(bulwarkObligations.id, base.id));

    const openDeadlines = await tx
      .select()
      .from(bulwarkNoticeDeadlines)
      .where(
        and(
          eq(bulwarkNoticeDeadlines.organization_id, orgId),
          eq(bulwarkNoticeDeadlines.obligation_id, base.id),
          eq(bulwarkNoticeDeadlines.status, 'open'),
        ),
      );

    for (const dl of openDeadlines) {
      if (outcome === 'terminate') {
        await tx
          .update(bulwarkNoticeDeadlines)
          .set({ status: 'voided', updated_at: new Date() })
          .where(eq(bulwarkNoticeDeadlines.id, dl.id));
        continue;
      }
      // restate: re-point to the successor obligation AND contract in one transaction (DK4).
      // Calendar-armed deadlines recompute their deterministic key to the successor (STJ4) so
      // the next radar tick does not mint a duplicate. Event/manual-armed deadlines re-point
      // and keep their existing key (full event-key recompute needs the arm-key components;
      // bulwark-state-reconcile re-derives the correct successor key from source state).
      let newKey = dl.triggering_event_id;
      if (dl.anchor_source === 'calendar') {
        const anchorDate = anchorDateInZone(new Date(dl.triggered_at), dl.resolved_timezone);
        newKey = calendarArmKey(successor.id, anchorDate);
      }
      // Guard against an already-armed successor deadline on the same key: drop the loser.
      const [conflict] = await tx
        .select({ id: bulwarkNoticeDeadlines.id })
        .from(bulwarkNoticeDeadlines)
        .where(
          and(
            eq(bulwarkNoticeDeadlines.organization_id, orgId),
            eq(bulwarkNoticeDeadlines.obligation_id, successor.id),
            eq(bulwarkNoticeDeadlines.triggering_event_id, newKey),
          ),
        )
        .limit(1);
      if (conflict) {
        await tx
          .update(bulwarkNoticeDeadlines)
          .set({ status: 'voided', updated_at: new Date() })
          .where(eq(bulwarkNoticeDeadlines.id, dl.id));
        continue;
      }
      await tx
        .update(bulwarkNoticeDeadlines)
        .set({
          obligation_id: successor.id,
          contract_id: successor.contract_id,
          triggering_event_id: newKey,
          updated_at: new Date(),
        })
        .where(eq(bulwarkNoticeDeadlines.id, dl.id));
    }
    void reason;
  });
}

// Manual trigger (spec 4.2 / D8 / DI7 / DK3). Restricted to obligations that are
// (unbound AND deadline_rule.from='trigger_event') OR whose contract has no project_id.
export async function triggerObligation(
  viewer: Viewer,
  id: string,
  occurredAt: string,
): Promise<{ armed: boolean; deadline_id: string | null }> {
  const { obligation, contract } = await loadScopedObligation(viewer, id);
  const binding = parseBinding(obligation.event_binding);
  const rule = parseRule(obligation.deadline_rule);
  const from = rule?.from ?? 'trigger_event';

  const isUnboundTriggerEvent = !!binding?.unbound && from === 'trigger_event';
  const isNoProject = contract.project_id === null;
  if (!isUnboundTriggerEvent && !isNoProject) {
    throw new ProjectScopeError(
      'Manual trigger is restricted to unbound trigger-event obligations or no-project contracts (DI7)',
    );
  }
  if (obligation.review_status !== 'confirmed' && obligation.review_status !== 'auto_confirmed') {
    throw new ValidationFailure('Only a confirmed obligation can be manually triggered', 'NOT_CONFIRMED');
  }

  // occurred_at plausibility (SH1): not in the future, not before effective_date minus a
  // grace of 1 day.
  const occurred = new Date(occurredAt);
  if (Number.isNaN(occurred.getTime()))
    throw new ValidationFailure('occurred_at is not a valid timestamp', 'BAD_OCCURRED_AT');
  const now = new Date();
  if (occurred.getTime() > now.getTime() + 60_000)
    throw new ValidationFailure('occurred_at cannot be in the future', 'FUTURE_OCCURRED_AT');
  if (contract.effective_date) {
    const floor = new Date(contract.effective_date).getTime() - 86_400_000;
    if (occurred.getTime() < floor)
      throw new ValidationFailure(
        'occurred_at is implausibly before the contract effective date',
        'BACKDATED_OCCURRED_AT',
      );
  }

  const timezone = rule?.timezone ?? contract.timezone;
  const effectiveRule: BulwarkDeadlineRule = rule ?? {
    offset_days: 0,
    unit: 'calendar_days',
    from: 'trigger_event',
    timezone,
    roll_forward: true,
    grace_hours: 0,
  };
  const { due_at, resolved_timezone } = computeDueAt({ anchor: occurred, rule: effectiveRule });

  const result = await armDeadline({
    orgId: viewer.org_id,
    obligationId: obligation.id,
    contractId: contract.id,
    projectId: contract.project_id,
    triggeringEventId: manualArmKey(obligation.id, occurred.toISOString()),
    anchorSource: 'manual',
    triggeredAt: occurred,
    resolvedTimezone: resolved_timezone,
    dueAt: due_at,
  });
  return { armed: result.armed, deadline_id: result.deadlineId };
}
