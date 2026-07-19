import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  bigint,
  numeric,
  boolean,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { organizations, users, projects } from './bbb-refs.js';
import { burnEngagements } from './burn-engagements.js';
import { burnDeliverables } from './burn-deliverables.js';

/**
 * The gate's REASON-OF-RECORD ARTIFACT (spec 3.1 / 5).
 *
 * `idempotency_key` is SERVER-DERIVED:
 *   hmac(INTERNAL_SERVICE_SECRET, caller_namespace || work_ref_type || work_ref_id ||
 *        proposed_amount || currency || attempt_nonce)
 * prefixed `svc:` or `usr:` and enforced by a CHECK. A caller-supplied key is rejected.
 * The re-validation of `proposed_amount`, `currency`, and `work_ref_type` on a hit is what
 * defeats the banked-verdict attack: an `allow` stored for a 1-cent charge must not be
 * returned for a $60,000 charge.
 *
 * SUPERSEDE-THEN-INSERT, NOT UPDATE-IN-PLACE (R2-T7). The unique index is PARTIAL:
 *   UNIQUE (organization_id, idempotency_key) WHERE superseded_at IS NULL
 * A mismatched or expired hit is superseded and a new row inserted in ONE transaction. A
 * total unique index left only two options, both bad: UPDATE in place, which destroys the
 * reason-of-record on the row, or INSERT and take a 23505 ON THE MONEY PATH, where the only
 * safe handler is fail-open.
 *
 * `is_calibrating` is true only for `svc:` rows with a resolvable ref (spec 2.4 point 10).
 * Only those count toward `min_advisory_decisions` and `min_labeled_denies`, so a member
 * cannot script 200 synthetic `manual` prechecks and satisfy the promotion volume gate.
 *
 * `overage_amount` stores the EXACT value and is quantized to `overage_bucket_amount` on
 * read for non-`read_all` callers. Note that quantizing the output alone is insufficient
 * (R3-S3): the verdict itself is the oracle, since the caller controls `proposed_amount`
 * and the verdict flips at `proposed_amount > envelope_remaining`. The deny for a
 * non-`read_all` caller is therefore evaluated against `envelope_remaining` ROUNDED DOWN to
 * `overage_bucket_amount`, so the decision boundary carries at most one bucket of
 * information no matter how many times it is probed.
 *
 * `advisory_feedback` is SPLIT BY VALUE (R2-S7): `right_call` and `would_have_mapped` are
 * member-writable on the caller's own non-enforced row and FEED NOTHING; `wrong_call`
 * requires `burn.precheck.mark_wrong` and is the only value in the demotion numerator. Same
 * split on `override_reason_code`: `gate_wrong` is `mark_wrong`-only.
 *
 * RETENTION: rows with `enforced=true`, a non-null override, a non-null `advisory_feedback`,
 * or a non-null `superseded_at` are NEVER purged. A superseded verdict is part of the
 * dispute record.
 *
 * `superseded_by` is a self-FK declared in migration 0240 via a guarded DO $$ block.
 */
export const burnPrechecks = pgTable(
  'burn_prechecks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    idempotency_key: varchar('idempotency_key', { length: 160 }).notNull(),
    superseded_at: timestamp('superseded_at', { withTimezone: true }),
    superseded_by: uuid('superseded_by'),
    valid_until: timestamp('valid_until', { withTimezone: true }).notNull(),
    is_calibrating: boolean('is_calibrating').notNull().default(false),
    // bill.expense | bill.recurring | bam.task_phase_move | bam.assignment |
    // subcontractor_charge | manual
    work_ref_type: varchar('work_ref_type', { length: 32 }).notNull(),
    // Null in the pre-transaction case, which is exactly why the synchronous path is
    // deterministic-only (Invariant 2): with no prior attribution to reuse there is no way
    // to reach a 0.85-confidence target inside the latency budget.
    work_ref_id: uuid('work_ref_id'),
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    proposed_amount: bigint('proposed_amount', { mode: 'number' }),
    currency: varchar('currency', { length: 3 }),
    engagement_id: uuid('engagement_id').references(() => burnEngagements.id, {
      onDelete: 'set null',
    }),
    chain_root_id: uuid('chain_root_id'),
    deliverable_id: uuid('deliverable_id').references(() => burnDeliverables.id, {
      onDelete: 'set null',
    }),
    // allow | allow_with_note | needs_mapping | deny
    verdict: varchar('verdict', { length: 20 }).notNull(),
    // within_envelope | envelope_exhausted | envelope_would_exceed | no_active_engagement |
    // engagement_unlinked | deliverable_closed | outside_engagement_window |
    // envelope_unpriced | low_confidence_target | gate_unavailable | gate_not_configured |
    // gate_off | gate_paused | redis_unavailable
    verdict_reason: varchar('verdict_reason', { length: 40 }).notNull(),
    mode_at_decision: varchar('mode_at_decision', { length: 12 }).notNull(),
    enforced: boolean('enforced').notNull().default(false),
    envelope_amount: bigint('envelope_amount', { mode: 'number' }),
    envelope_consumed: bigint('envelope_consumed', { mode: 'number' }),
    envelope_remaining: bigint('envelope_remaining', { mode: 'number' }),
    overage_amount: bigint('overage_amount', { mode: 'number' }),
    confidence: numeric('confidence', { precision: 5, scale: 2 }),
    clause_ref: varchar('clause_ref', { length: 64 }),
    // pending | proceeded | abandoned | overridden | mapped | mapped_and_posted |
    // change_order_raised | absorbed
    outcome: varchar('outcome', { length: 24 }).notNull().default('pending'),
    // right_call | would_have_mapped (member-writable, feed nothing) |
    // wrong_call (burn.precheck.mark_wrong only, in the numerator)
    advisory_feedback: varchar('advisory_feedback', { length: 16 }),
    // absorbed_cost | mapped_manually | change_order_pending | gate_wrong (mark_wrong only)
    override_reason_code: varchar('override_reason_code', { length: 24 }),
    override_reason_text: text('override_reason_text'),
    overridden_by: uuid('overridden_by').references(() => users.id, { onDelete: 'set null' }),
    overridden_at: timestamp('overridden_at', { withTimezone: true }),
    latency_ms: integer('latency_ms'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_burn_prechecks_org_verdict_created').on(
      table.organization_id,
      table.verdict,
      table.created_at,
    ),
    index('idx_burn_prechecks_org_enforced_created').on(
      table.organization_id,
      table.enforced,
      table.created_at,
    ),
    // The calibration scan.
    index('idx_burn_prechecks_org_calibration').on(
      table.organization_id,
      table.mode_at_decision,
      table.is_calibrating,
      table.created_at,
    ),
    index('idx_burn_prechecks_org_chain').on(table.organization_id, table.chain_root_id),
  ],
);
