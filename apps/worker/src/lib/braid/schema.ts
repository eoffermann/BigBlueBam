// Local Drizzle pgTable stubs for the Braid engine running in apps/worker.
//
// The worker follows the established no-cross-api-import convention (see
// blast-send.job.ts / agent-webhook-dispatch.job.ts): rather than import braid-api's
// Drizzle config, it declares the minimal shape it needs against the SAME physical
// tables. Columns must stay in sync with apps/braid-api/src/db/schema/*.ts and the
// source-app schemas. No FK .references() here (the worker never creates the tables).

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  jsonb,
  integer,
  numeric,
  boolean,
  timestamp,
} from 'drizzle-orm/pg-core';

// ── Enums (values must match the DB enum types) ──────────────────────────────
export const actorTypeEnum = pgEnum('actor_type', ['human', 'agent', 'service']);
export const proposalStatusEnum = pgEnum('proposal_status', [
  'pending',
  'approved',
  'rejected',
  'expired',
  'revoked',
  'revising',
]);
export const entityLinkKindEnum = pgEnum('entity_link_kind', [
  'related_to',
  'duplicates',
  'blocks',
  'references',
  'parent_of',
  'derived_from',
]);

// ── Braid tables ─────────────────────────────────────────────────────────────
export const braidProfiles = pgTable('braid_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').notNull(),
  kind: varchar('kind', { length: 8 }).notNull(),
  display_name: varchar('display_name', { length: 320 }),
  primary_email: varchar('primary_email', { length: 320 }),
  primary_phone: varchar('primary_phone', { length: 64 }),
  email_suppressed: boolean('email_suppressed').notNull().default(false),
  company_profile_id: uuid('company_profile_id'),
  attributes: jsonb('attributes').notNull().default('{}'),
  identity_count: integer('identity_count').notNull().default(0),
  confidence: numeric('confidence', { precision: 5, scale: 2 }),
  status: varchar('status', { length: 12 }).notNull().default('active'),
  merged_into_id: uuid('merged_into_id'),
  qdrant_point_id: uuid('qdrant_point_id'),
  qdrant_synced_at: timestamp('qdrant_synced_at', { withTimezone: true }),
  last_event_published_at: timestamp('last_event_published_at', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const braidIdentities = pgTable('braid_identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').notNull(),
  profile_id: uuid('profile_id').notNull(),
  source_type: text('source_type').notNull(),
  source_id: uuid('source_id').notNull(),
  match_keys: jsonb('match_keys').notNull().default('{}'),
  raw_attributes: jsonb('raw_attributes').notNull().default('{}'),
  source_synced_at: timestamp('source_synced_at', { withTimezone: true }),
  needs_rescan: boolean('needs_rescan').notNull().default(false),
  link_confidence: numeric('link_confidence', { precision: 5, scale: 2 }),
  link_evidence: jsonb('link_evidence').notNull().default('{}'),
  link_kind: varchar('link_kind', { length: 8 }).notNull().default('auto'),
  linked_by: uuid('linked_by'),
  linked_at: timestamp('linked_at', { withTimezone: true }).defaultNow().notNull(),
});

export const braidMatchCandidates = pgTable('braid_match_candidates', {
  id: uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').notNull(),
  profile_a_id: uuid('profile_a_id').notNull(),
  profile_b_id: uuid('profile_b_id').notNull(),
  bridge_identity_a_id: uuid('bridge_identity_a_id').notNull(),
  bridge_identity_b_id: uuid('bridge_identity_b_id').notNull(),
  score: numeric('score', { precision: 5, scale: 2 }).notNull(),
  evidence: jsonb('evidence').notNull(),
  rationale: text('rationale'),
  status: varchar('status', { length: 12 }).notNull().default('pending'),
  proposal_id: uuid('proposal_id'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  decided_at: timestamp('decided_at', { withTimezone: true }),
});

export const braidMergeDecisions = pgTable('braid_merge_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').notNull(),
  decision_kind: varchar('decision_kind', { length: 8 }).notNull(),
  surviving_profile_id: uuid('surviving_profile_id'),
  absorbed_profile_id: uuid('absorbed_profile_id'),
  affected_identity_ids: jsonb('affected_identity_ids').notNull().default('[]'),
  reverses_decision_id: uuid('reverses_decision_id'),
  candidate_id: uuid('candidate_id'),
  score_at_decision: numeric('score_at_decision', { precision: 5, scale: 2 }),
  decided_by: uuid('decided_by').notNull(),
  decided_by_kind: actorTypeEnum('decided_by_kind').notNull(),
  reason: text('reason'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const braidSurvivorshipRules = pgTable('braid_survivorship_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').notNull(),
  kind: varchar('kind', { length: 8 }).notNull(),
  field: varchar('field', { length: 64 }).notNull(),
  strategy: varchar('strategy', { length: 20 }).notNull(),
  source_priority: jsonb('source_priority').notNull().default('[]'),
  pinned_value: jsonb('pinned_value'),
  updated_by: uuid('updated_by'),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const braidOrgSettings = pgTable('braid_org_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').notNull(),
  auto_merge_threshold: numeric('auto_merge_threshold', { precision: 5, scale: 2 })
    .notNull()
    .default('0.92'),
  review_threshold: numeric('review_threshold', { precision: 5, scale: 2 }).notNull().default('0.60'),
  require_strong_signal_for_auto: boolean('require_strong_signal_for_auto').notNull().default(true),
  enabled_source_types: jsonb('enabled_source_types').notNull().default('[]'),
  rescan_max_age_days: integer('rescan_max_age_days'),
  last_rescan_at: timestamp('last_rescan_at', { withTimezone: true }),
  updated_by: uuid('updated_by'),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ── Shared platform tables (note org_id, not organization_id: the D8 boundary) ──
export const dedupeDecisions = pgTable('dedupe_decisions', {
  id: uuid('id').primaryKey().defaultRandom(),
  org_id: uuid('org_id').notNull(),
  entity_type: text('entity_type').notNull(),
  id_a: uuid('id_a').notNull(),
  id_b: uuid('id_b').notNull(),
  decision: text('decision').notNull(),
  decided_by: uuid('decided_by').notNull(),
  decided_at: timestamp('decided_at', { withTimezone: true }).defaultNow().notNull(),
  reason: text('reason'),
  confidence_at_decision: numeric('confidence_at_decision', { precision: 5, scale: 2 }),
  resurface_after: timestamp('resurface_after', { withTimezone: true }),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

export const agentProposals = pgTable('agent_proposals', {
  id: uuid('id').primaryKey().defaultRandom(),
  org_id: uuid('org_id').notNull(),
  actor_id: uuid('actor_id').notNull(),
  proposer_kind: actorTypeEnum('proposer_kind').notNull(),
  proposed_action: text('proposed_action').notNull(),
  proposed_payload: jsonb('proposed_payload').notNull().default('{}'),
  subject_type: text('subject_type'),
  subject_id: uuid('subject_id'),
  approver_id: uuid('approver_id'),
  status: proposalStatusEnum('status').notNull().default('pending'),
  decided_at: timestamp('decided_at', { withTimezone: true }),
  decision_reason: text('decision_reason'),
  expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const entityLinks = pgTable('entity_links', {
  id: uuid('id').primaryKey().defaultRandom(),
  org_id: uuid('org_id').notNull(),
  src_type: text('src_type').notNull(),
  src_id: uuid('src_id').notNull(),
  dst_type: text('dst_type').notNull(),
  dst_id: uuid('dst_id').notNull(),
  link_kind: entityLinkKindEnum('link_kind').notNull(),
  created_by: uuid('created_by'),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// ── Source tables (read-only; the worker reads source rows directly, spec 4.1) ──
export const bondContacts = pgTable('bond_contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').notNull(),
  first_name: varchar('first_name', { length: 100 }),
  last_name: varchar('last_name', { length: 100 }),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  title: varchar('title', { length: 150 }),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deleted_at: timestamp('deleted_at', { withTimezone: true }),
});

export const bondCompanies = pgTable('bond_companies', {
  id: uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  domain: varchar('domain', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  website: text('website'),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  deleted_at: timestamp('deleted_at', { withTimezone: true }),
});

export const billClients = pgTable('bill_clients', {
  id: uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  email: varchar('email', { length: 255 }),
  phone: varchar('phone', { length: 50 }),
  bond_company_id: uuid('bond_company_id'),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const bookEventAttendees = pgTable('book_event_attendees', {
  id: uuid('id').primaryKey().defaultRandom(),
  event_id: uuid('event_id').notNull(),
  user_id: uuid('user_id'),
  email: varchar('email', { length: 255 }).notNull(),
  name: varchar('name', { length: 200 }),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export const bookEvents = pgTable('book_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  organization_id: uuid('organization_id').notNull(),
});

export const helpdeskUsers = pgTable('helpdesk_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  org_id: uuid('org_id'),
  email: varchar('email', { length: 320 }).notNull(),
  display_name: varchar('display_name', { length: 100 }).notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
