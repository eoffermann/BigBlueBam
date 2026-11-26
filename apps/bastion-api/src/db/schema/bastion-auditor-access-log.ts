// Mirrors bastion_auditor_access_log as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { pgTable, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { bastionAuditorRooms } from './bastion-auditor-rooms.js';
import { organizations } from './bbb-refs.js';

export const bastionAuditorAccessLog = pgTable(
  'bastion_auditor_access_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    room_id: uuid('room_id').notNull().references(() => bastionAuditorRooms.id, { onDelete: 'restrict' }),
    accessed_at: timestamp('accessed_at', { withTimezone: true }).defaultNow().notNull(),
    view_kind: varchar('view_kind', { length: 16 }).notNull(),
    object_ref: varchar('object_ref', { length: 256 }),
    ip_hash: varchar('ip_hash', { length: 64 }),
    user_agent_trunc: varchar('user_agent_trunc', { length: 256 }),
  },
);
