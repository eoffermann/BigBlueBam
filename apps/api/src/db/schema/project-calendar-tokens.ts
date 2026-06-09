import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { projects } from './projects.js';
import { organizations } from './organizations.js';
import { users } from './users.js';

// Public iCal feed tokens scoped to a single project. Anyone holding
// the token can fetch the project's .ics feed at
// /v1/public/projects/:id/calendar.ics — no session, no API key, no org
// membership required. Revocable at any time by the project owner.
export const projectCalendarTokens = pgTable(
  'project_calendar_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    token_prefix: text('token_prefix').notNull(),
    token_hash: text('token_hash').notNull(),
    name: text('name').default('Project schedule').notNull(),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    last_used_at: timestamp('last_used_at', { withTimezone: true }),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    index('idx_project_calendar_tokens_project_id').on(table.project_id),
    index('idx_project_calendar_tokens_prefix_live').on(table.token_prefix),
  ],
);
