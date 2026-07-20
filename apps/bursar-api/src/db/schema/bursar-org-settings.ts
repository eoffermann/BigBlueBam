import { pgTable, uuid, integer, numeric, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

/**
 * Per-org settings (spec 6.1, migration 0247). One row per org: every threshold, lexicon,
 * and cap with its default. ALL columns are audited with a before/after diff at the service
 * layer (spec 5.6).
 */
export const bursarOrgSettings = pgTable('bursar_org_settings', {
  organization_id: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  llm_provider_id: uuid('llm_provider_id'),
  node_term_overlap_floor: numeric('node_term_overlap_floor', { precision: 5, scale: 4 })
    .notNull()
    .default('0.3000'),
  // §4.3 caps at their spec defaults (corrected from the M1 seed of 25/100 in migration 0254): the
  // split-blanket attack (14 mandatory nodes over 4 lines) must trip a cap of 4, not slip under 100.
  blanket_fanout_cap: integer('blanket_fanout_cap').notNull().default(4),
  blanket_cumulative_cap: integer('blanket_cumulative_cap').notNull().default(4),
  evidence_concentration_floor: numeric('evidence_concentration_floor', { precision: 5, scale: 4 })
    .notNull()
    .default('0.5000'),
  max_nodes_per_run: integer('max_nodes_per_run').notNull().default(400),
  max_offers_per_run: integer('max_offers_per_run').notNull().default(12),
  max_llm_calls_per_run: integer('max_llm_calls_per_run').notNull().default(2000),
  max_lines_per_window: integer('max_lines_per_window').notNull().default(80),
  window_overlap_lines: integer('window_overlap_lines').notNull().default(10),
  price_drift_threshold_pct: numeric('price_drift_threshold_pct', { precision: 5, scale: 2 })
    .notNull()
    .default('10.00'),
  renewal_lead_bands: jsonb('renewal_lead_bands')
    .notNull()
    .default(['t_minus_90', 't_minus_60', 't_minus_30', 't_minus_7']),
  // Spec floor 0.35 (corrected from the M1 seed of 0.40 in migration 0254). Below this an offer is
  // `unparseable` and can never produce an `absent` verdict (spec 4.1).
  parse_quality_floor: numeric('parse_quality_floor', { precision: 5, scale: 4 }).notNull().default('0.3500'),
  payee_match_threshold: numeric('payee_match_threshold', { precision: 5, scale: 4 })
    .notNull()
    .default('0.4500'),
  payee_auto_accept_threshold: numeric('payee_auto_accept_threshold', { precision: 5, scale: 4 })
    .notNull()
    .default('0.6500'),
  blanket_lexicon: jsonb('blanket_lexicon').notNull().default([]),
  exclusion_lexicon: jsonb('exclusion_lexicon').notNull().default([]),
  digest_day: integer('digest_day').notNull().default(1),
  digest_hour: integer('digest_hour').notNull().default(8),
  retention_days: integer('retention_days').notNull().default(730),
  updated_by: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
