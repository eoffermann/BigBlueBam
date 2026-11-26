// Mirrors bastion_auditor_requests as created by the Bastion migrations (0274-0280; spec 4.1). Columns only:
// CHECK constraints, partial/unique indexes, immutability triggers and the RLS policy live in
// the migration, which is the single source of truth (CLAUDE.md). db:check diffs these columns.
import { pgTable, text, timestamp, uuid, varchar } from 'drizzle-orm/pg-core';
import { bastionAuditorRooms } from './bastion-auditor-rooms.js';
import { bastionControls } from './bastion-controls.js';
import { organizations, users } from './bbb-refs.js';

export const bastionAuditorRequests = pgTable(
  'bastion_auditor_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id').notNull().references(() => organizations.id, { onDelete: 'cascade' }),
    room_id: uuid('room_id').notNull().references(() => bastionAuditorRooms.id, { onDelete: 'cascade' }),
    control_id: uuid('control_id').references(() => bastionControls.id, { onDelete: 'set null' }),
    requester_name: varchar('requester_name', { length: 256 }),
    body: varchar('body', { length: 5000 }).notNull(),
    status: varchar('status', { length: 16 }).default('open').notNull(),
    answered_by: uuid('answered_by').references(() => users.id, { onDelete: 'set null' }),
    answer_note: text('answer_note'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
);
