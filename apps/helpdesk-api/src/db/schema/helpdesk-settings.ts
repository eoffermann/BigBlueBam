import { pgTable, uuid, varchar, text, integer, boolean, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, projects, phases } from './bbb-refs.js';

export const helpdeskSettings = pgTable('helpdesk_settings', {
  id: uuid('id').primaryKey().defaultRandom(),
  org_id: uuid('org_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' })
    .unique(),
  require_email_verification: boolean('require_email_verification').default(false).notNull(),
  allowed_email_domains: text('allowed_email_domains')
    .array()
    .default(sql`'{}'::text[]`)
    .notNull(),
  default_project_id: uuid('default_project_id').references(() => projects.id, { onDelete: 'set null' }),
  default_phase_id: uuid('default_phase_id').references(() => phases.id),
  default_priority: varchar('default_priority', { length: 20 }).default('medium').notNull(),
  categories: jsonb('categories').default([]).notNull(),
  welcome_message: text('welcome_message'),
  auto_close_days: integer('auto_close_days').default(0).notNull(),
  notify_on_status_change: boolean('notify_on_status_change').default(true).notNull(),
  notify_on_agent_reply: boolean('notify_on_agent_reply').default(true).notNull(),
  // G4 / SLA tracking (migration 0111). Minutes from ticket.created_at
  // to first agent public reply before the first-response SLA is breached,
  // and minutes to resolution before the resolution SLA is breached.
  // Defaults target an 8-hour business-day first-response SLA and a 48-
  // hour resolution SLA; admins adjust per-org via PATCH /helpdesk/settings.
  sla_first_response_minutes: integer('sla_first_response_minutes').default(480).notNull(),
  sla_resolution_minutes: integer('sla_resolution_minutes').default(2880).notNull(),
  created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});
