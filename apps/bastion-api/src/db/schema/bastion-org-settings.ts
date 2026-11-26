// Mirrors bastion_org_settings as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { bigint, boolean, integer, jsonb, numeric, pgTable, smallint, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

export const bastionOrgSettings = pgTable(
  'bastion_org_settings',
  {
    organization_id: uuid('organization_id').primaryKey().references(() => organizations.id, { onDelete: 'cascade' }),
    llm_provider_id: uuid('llm_provider_id'),
    compliance_project_id: uuid('compliance_project_id'),
    remediation_tasks: varchar('remediation_tasks', { length: 16 }).default('create').notNull(),
    timezone: varchar('timezone', { length: 64 }).default('UTC').notNull(),
    evaluation_hour_local: smallint('evaluation_hour_local').default(3).notNull(),
    evaluation_minute_offset: smallint('evaluation_minute_offset').default(0).notNull(),
    stale_after_hours: integer('stale_after_hours').default(36).notNull(),
    not_assessed_grace_days: integer('not_assessed_grace_days').default(14).notNull(),
    manual_expiry_warn_days: integer('manual_expiry_warn_days').default(30).notNull(),
    questionnaire_high_floor: numeric('questionnaire_high_floor', { precision: 4, scale: 3 }).default('0.800').notNull(),
    questionnaire_medium_floor: numeric('questionnaire_medium_floor', { precision: 4, scale: 3 }).default('0.550').notNull(),
    max_llm_calls_per_compile: integer('max_llm_calls_per_compile').default(400).notNull(),
    max_llm_calls_per_questionnaire: integer('max_llm_calls_per_questionnaire').default(1200).notNull(),
    max_rows_per_questionnaire: integer('max_rows_per_questionnaire').default(1000).notNull(),
    auditor_room_max_days: integer('auditor_room_max_days').default(90).notNull(),
    max_packet_bytes: bigint('max_packet_bytes', { mode: 'number' }).default(2147483648).notNull(),
    company_profile: jsonb('company_profile').default({}).notNull(),
    offsite_backup_configured: boolean('offsite_backup_configured').default(false).notNull(),
    bucket_check_status: varchar('bucket_check_status', { length: 32 }),
    updated_by: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
