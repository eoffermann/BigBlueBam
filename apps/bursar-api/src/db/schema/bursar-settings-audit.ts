import { pgTable, uuid, jsonb, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

/**
 * Settings change audit (spec 5.6, migration 0252). EVERY write to bursar_org_settings records
 * a before/after diff here, not just the lexicons: otherwise an admin can zero the
 * `span_verified` weight (or any threshold) and silently suppress findings with no trail.
 *
 * Org-scoped, so it is a bursar_* table (and picked up by the generated RLS loop, re-run in
 * 0252). The platform activity_log is deliberately NOT used: its project_id is NOT NULL and
 * Bursar is org-scoped with no project to attribute a settings change to.
 *
 * `changes` is an array of { field, before, after } objects over the audited setting keys.
 */
export const bursarSettingsAudit = pgTable(
  'bursar_settings_audit',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    actor_id: uuid('actor_id')
      .notNull()
      .references(() => users.id),
    changes: jsonb('changes').notNull().default([]),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bursar_settings_audit_org_created').on(table.organization_id, table.created_at),
  ],
);
