import {
  pgTable,
  uuid,
  varchar,
  integer,
  bigint,
  numeric,
  boolean,
  jsonb,
  timestamp,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

/**
 * One row per org. Every threshold in the spec, with its default AND its CHECK (spec 3.1).
 *
 * `gate_mode` defaults to `advisory` and `blocking` is UNREACHABLE without the seven
 * measurable preconditions of spec 5.4, enforced server-side. `gate_enabled_refs` defaults
 * to `["bill.expense"]` because blocking is only ever appropriate for money-out classes:
 * task-phase and assignment refs are rejected if marked blocking.
 *
 * `precheck_budget_ms` is ADVISORY AND DISPLAY-ONLY. The authoritative bound is bill-api's
 * `BURN_PRECHECK_TIMEOUT_MS`, because the timeout that matters is the one held by the caller
 * that fails open, not a number the callee stores about itself.
 *
 * `min_advisory_decisions` counts `svc:` rows ONLY (spec 2.4 point 10), and
 * `usr_precheck_daily_cap` bounds member-writable inserts, so a member cannot manufacture a
 * calibration sample.
 *
 * `claim_lease_seconds` is a real column rather than a constant (R2-T9) because the drain
 * heartbeats at `claim_lease_seconds / 3` and `attribute_batch_size` is bounded so the
 * worst-case batch duration sits inside the lease. Those three numbers have to agree, and
 * agreement is only checkable if the lease is stored.
 *
 * `embedding_enabled` defaults FALSE: `embedding.service.ts:17` returns zero vectors, so
 * shipping it on would be shipping a retrieval stage that retrieves nothing.
 *
 * `llm_provider_id` ORG OWNERSHIP IS VALIDATED ON WRITE (spec 2.4 point 12).
 * `apps/api/src/routes/internal-llm.routes.ts:117-126` resolves a provider by `id` and
 * `enabled` only, with no org predicate, so a Burn org admin who learned another org's
 * provider id would get that tenant's decrypted key used on their behalf.
 */
export const burnOrgSettings = pgTable('burn_org_settings', {
  organization_id: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),

  // ── The gate ────────────────────────────────────────────────────────────
  // off | advisory | blocking
  gate_mode: varchar('gate_mode', { length: 12 }).notNull().default('advisory'),
  gate_enabled_refs: jsonb('gate_enabled_refs').notNull().default(['bill.expense']),
  gate_paused_until: timestamp('gate_paused_until', { withTimezone: true }),
  deny_threshold: numeric('deny_threshold', { precision: 5, scale: 2 }).notNull().default('0.85'),
  map_threshold: numeric('map_threshold', { precision: 5, scale: 2 }).notNull().default('0.60'),

  // ── Attribution thresholds ──────────────────────────────────────────────
  auto_attribute_threshold: numeric('auto_attribute_threshold', { precision: 5, scale: 2 })
    .notNull()
    .default('0.90'),
  review_threshold: numeric('review_threshold', { precision: 5, scale: 2 })
    .notNull()
    .default('0.60'),
  pending_review_max_age_days: integer('pending_review_max_age_days').notNull().default(14),
  reconcile_window_days: integer('reconcile_window_days').notNull().default(90),

  // ── Disclosure controls ─────────────────────────────────────────────────
  overage_bucket_amount: bigint('overage_bucket_amount', { mode: 'number' })
    .notNull()
    .default(10000),
  min_contributors_for_cost_aggregate: integer('min_contributors_for_cost_aggregate')
    .notNull()
    .default(3),

  // ── Rules ───────────────────────────────────────────────────────────────
  match_ceiling_pct: numeric('match_ceiling_pct', { precision: 5, scale: 2 })
    .notNull()
    .default('40'),

  // ── Promotion / demotion (spec 5.4, 5.6) ────────────────────────────────
  max_false_positive_rate: numeric('max_false_positive_rate', { precision: 5, scale: 2 })
    .notNull()
    .default('0.05'),
  min_gate_wrong_count: integer('min_gate_wrong_count').notNull().default(5),
  min_gate_wrong_distinct_users: integer('min_gate_wrong_distinct_users').notNull().default(2),
  min_advisory_decisions: integer('min_advisory_decisions').notNull().default(200),
  min_advisory_days_alt: integer('min_advisory_days_alt').notNull().default(60),
  min_advisory_days: integer('min_advisory_days').notNull().default(14),
  min_labeled_denies: integer('min_labeled_denies').notNull().default(10),
  min_deny_precision: numeric('min_deny_precision', { precision: 5, scale: 2 })
    .notNull()
    .default('0.95'),
  min_priced_deliverable_coverage_pct: numeric('min_priced_deliverable_coverage_pct', {
    precision: 5,
    scale: 2,
  })
    .notNull()
    .default('60'),
  min_gate_coverage_pct: numeric('min_gate_coverage_pct', { precision: 5, scale: 2 })
    .notNull()
    .default('0.90'),
  min_gate_unavailable_days: integer('min_gate_unavailable_days').notNull().default(2),

  // ── Precheck path ───────────────────────────────────────────────────────
  precheck_budget_ms: integer('precheck_budget_ms').notNull().default(600),
  precheck_replay_ttl_seconds: integer('precheck_replay_ttl_seconds').notNull().default(300),
  usr_precheck_daily_cap: integer('usr_precheck_daily_cap').notNull().default(200),
  usr_precheck_per_deliverable_cap: integer('usr_precheck_per_deliverable_cap')
    .notNull()
    .default(5),
  override_reason_min_chars: integer('override_reason_min_chars').notNull().default(20),

  // ── Queues, caps, retrieval ─────────────────────────────────────────────
  unscoped_alert_floor: bigint('unscoped_alert_floor', { mode: 'number' }).notNull().default(10000),
  candidate_k: integer('candidate_k').notNull().default(8),
  exemplar_k: integer('exemplar_k').notNull().default(6),
  attribution_llm_daily_cap: integer('attribution_llm_daily_cap').notNull().default(2000),
  attribute_batch_size: integer('attribute_batch_size').notNull().default(25),
  claim_lease_seconds: integer('claim_lease_seconds').notNull().default(300),
  rollup_max_age_minutes: integer('rollup_max_age_minutes').notNull().default(120),
  variance_detail_max_refs: integer('variance_detail_max_refs').notNull().default(50),

  // ── Optional signal sources (all default off) ───────────────────────────
  embedding_enabled: boolean('embedding_enabled').notNull().default(false),
  banter_signal_enabled: boolean('banter_signal_enabled').notNull().default(false),
  vcs_signal_enabled: boolean('vcs_signal_enabled').notNull().default(false),
  llm_provider_id: uuid('llm_provider_id'),
  vocabulary_version: integer('vocabulary_version').notNull().default(0),

  // ── Watermarks and retention ────────────────────────────────────────────
  // Per-source_type created_at high-water marks, e.g.
  // { "bam.time_entry": "2026-07-19T05:00:00Z", "bill.expense": "..." }
  last_source_watermark: jsonb('last_source_watermark').notNull().default({}),
  work_item_retention_days: integer('work_item_retention_days').notNull().default(1095),
  ingest_retention_days: integer('ingest_retention_days').notNull().default(400),
  // Advanced ONLY after a fully successful sweep, so a partial sweep re-runs its window.
  last_variance_sweep_at: timestamp('last_variance_sweep_at', { withTimezone: true }),

  // ── Audit ───────────────────────────────────────────────────────────────
  gate_promoted_at: timestamp('gate_promoted_at', { withTimezone: true }),
  gate_demoted_at: timestamp('gate_demoted_at', { withTimezone: true }),
  updated_by: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
