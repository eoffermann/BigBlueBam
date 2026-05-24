// Slack import (docs/plans/slack-import-design.md §4b). Drizzle declaration
// for banter_slack_imports — the durable per-upload audit + status row used
// by the upload endpoint, the worker, the polling status endpoint, and the
// abort/cleanup flow. Backed by migration 0165_banter_slack_imports.sql.
//
// One row per upload. Aborted imports retain their row; re-runs create a
// fresh row. The mapping JSONB stores the §1 Step 2 wizard payload (project
// choice, per-user actions, per-channel actions, options).

import {
  pgTable,
  uuid,
  text,
  bigint,
  integer,
  timestamp,
  jsonb,
  index,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, projects, users } from './bbb-refs.js';
import { banterChannelGroups } from './channel-groups.js';

export const banterSlackImports = pgTable(
  'banter_slack_imports',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    project_id: uuid('project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    channel_group_id: uuid('channel_group_id').references(
      () => banterChannelGroups.id,
      { onDelete: 'set null' },
    ),
    initiated_by: uuid('initiated_by')
      .notNull()
      .references(() => users.id),
    workspace_name: text('workspace_name').notNull(),
    workspace_url: text('workspace_url'),
    source_filename: text('source_filename').notNull(),
    source_size_bytes: bigint('source_size_bytes', { mode: 'number' }).notNull(),
    source_minio_key: text('source_minio_key').notNull(),
    mapping: jsonb('mapping').notNull(),
    // pending | unpacking | mapping | queued | importing | reconciling | done | failed | aborted
    status: text('status').notNull().default('pending'),
    phase: text('phase'),
    progress_total: integer('progress_total').notNull().default(0),
    progress_done: integer('progress_done').notNull().default(0),
    // { users, channels, messages, files, reactions, pins }
    totals_imported: jsonb('totals_imported').notNull().default(sql`'{}'::jsonb`),
    totals_skipped: jsonb('totals_skipped').notNull().default(sql`'{}'::jsonb`),
    error_message: text('error_message'),
    started_at: timestamp('started_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    index('banter_slack_imports_org_id_idx').on(table.org_id, table.created_at),
  ],
);
