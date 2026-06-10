import { pgTable, uuid, varchar, boolean, timestamp, index } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { organizations } from './organizations.js';

/**
 * Per-project calling overrides. Each column is nullable; NULL means
 * "inherit from org" (which itself falls back to platform defaults).
 *
 * Read-time inheritance is implemented in
 * apps/api/src/services/project-calling-settings.service.ts —
 * getEffectiveCallingSettings(projectId) walks project -> org
 * (banter_settings) -> platform (system_settings calling.*) and returns
 * the most specific non-NULL value at each tier.
 *
 * Migration: 0175_project_calling_settings.sql.
 * Bureau prerequisite P-4 (see docs/plans/bureau-calling-audit.md §3).
 */
export const projectCallingSettings = pgTable(
  'project_calling_settings',
  {
    project_id: uuid('project_id')
      .primaryKey()
      .references(() => projects.id, { onDelete: 'cascade' }),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    // NULL on any of these = inherit from org; non-NULL = explicit override.
    calling_enabled: boolean('calling_enabled'),
    allow_recording: boolean('allow_recording'),
    allow_transcription: boolean('allow_transcription'),
    // Reserved for Bureau (default office privacy when a per-project room
    // is auto-created). Free-form short label so we don't have to ship an
    // enum migration when Bureau lands.
    default_office_privacy: varchar('default_office_privacy', { length: 16 }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_project_calling_settings_org_id').on(table.org_id),
  ],
);

export type ProjectCallingSettings = typeof projectCallingSettings.$inferSelect;
export type ProjectCallingSettingsInsert = typeof projectCallingSettings.$inferInsert;
