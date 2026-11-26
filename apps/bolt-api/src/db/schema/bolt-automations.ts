import {
  pgTable,
  pgEnum,
  uuid,
  varchar,
  text,
  boolean,
  integer,
  jsonb,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { BOLT_SOURCES } from '@bigbluebam/shared';
import { organizations, projects, users } from './bbb-refs.js';

// Values derive from the single shared list (issue #124). The live Postgres enum is
// extended by migrations (0041, 0121, 0260, ...) and checked against BOLT_SOURCES by
// scripts/check-bolt-enum.mjs in the db-drift CI job.
export const boltTriggerSourceEnum = pgEnum('bolt_trigger_source', BOLT_SOURCES);

export const boltAutomations = pgTable(
  'bolt_automations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    enabled: boolean('enabled').default(true).notNull(),

    trigger_source: boltTriggerSourceEnum('trigger_source').notNull(),
    trigger_event: varchar('trigger_event', { length: 60 }).notNull(),
    trigger_filter: jsonb('trigger_filter'),
    cron_expression: varchar('cron_expression', { length: 100 }),
    cron_timezone: varchar('cron_timezone', { length: 50 }).default('UTC').notNull(),

    max_executions_per_hour: integer('max_executions_per_hour').default(100).notNull(),
    cooldown_seconds: integer('cooldown_seconds').default(0).notNull(),
    max_chain_depth: integer('max_chain_depth').default(5).notNull(),
    template_strict: boolean('template_strict').default(false).notNull(),
    notify_owner_on_failure: boolean('notify_owner_on_failure').default(false).notNull(),

    graph: jsonb('graph'),
    graph_mode: varchar('graph_mode', { length: 16 }),
    data_version: integer('data_version').notNull().default(1),

    last_executed_at: timestamp('last_executed_at', { withTimezone: true }),

    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    updated_by: uuid('updated_by').references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bolt_automations_org_id').on(table.org_id),
    index('idx_bolt_automations_project_id').on(table.project_id),
    index('idx_bolt_automations_trigger').on(table.trigger_source, table.trigger_event),
    index('idx_bolt_automations_enabled').on(table.enabled),
  ],
);
