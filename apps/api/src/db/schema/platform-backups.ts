import { pgTable, uuid, text, bigint, timestamp, index } from 'drizzle-orm/pg-core';
import { users } from './users.js';

// Whole-database pg_dump backups (Backup app, Platform scope). SuperUser-only,
// platform-level metadata - deliberately no organization_id and no RLS policy.
// See infra/postgres/migrations/0226_platform_backups.sql.
export const platformBackups = pgTable(
  'platform_backups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: text('scope').notNull().default('platform'),
    kind: text('kind').notNull(), // 'manual' | 'scheduled'
    status: text('status').notNull().default('pending'), // 'pending' | 'running' | 'completed' | 'failed'
    storage_key: text('storage_key'),
    size_bytes: bigint('size_bytes', { mode: 'number' }),
    pg_version: text('pg_version'),
    integrity: text('integrity'),
    triggered_by_user_id: uuid('triggered_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    started_at: timestamp('started_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    error: text('error'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_platform_backups_created_at').on(table.created_at),
    index('idx_platform_backups_status').on(table.status),
  ],
);

// Restore runs (audit + progress). A restore is destructive, so the typed
// confirmation phrase the SuperUser entered is retained for the audit trail.
export const platformRestores = pgTable(
  'platform_restores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    backup_id: uuid('backup_id').references(() => platformBackups.id, { onDelete: 'set null' }),
    status: text('status').notNull().default('pending'), // 'pending' | 'running' | 'completed' | 'failed'
    requested_by_user_id: uuid('requested_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    confirmation_phrase: text('confirmation_phrase'),
    started_at: timestamp('started_at', { withTimezone: true }),
    completed_at: timestamp('completed_at', { withTimezone: true }),
    error: text('error'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_platform_restores_created_at').on(table.created_at)],
);
