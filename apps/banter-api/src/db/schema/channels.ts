import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations, projects, users } from './bbb-refs.js';
import { banterChannelGroups } from './channel-groups.js';

export const banterChannels = pgTable(
  'banter_channels',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 80 }).notNull(),
    display_name: varchar('display_name', { length: 100 }),
    slug: varchar('slug', { length: 80 }).notNull(),
    type: varchar('type', { length: 20 }).notNull().default('public'),
    topic: varchar('topic', { length: 500 }),
    description: text('description'),
    icon: varchar('icon', { length: 10 }),
    channel_group_id: uuid('channel_group_id').references(() => banterChannelGroups.id, {
      onDelete: 'set null',
    }),
    // Slack import (migration 0164). Nullable FK to projects.id — the
    // import wizard sets this so a channel is scoped to a project; standard
    // Banter channels stay NULL. ON DELETE SET NULL preserves chat history.
    project_id: uuid('project_id').references(() => projects.id, { onDelete: 'set null' }),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    is_archived: boolean('is_archived').notNull().default(false),
    is_default: boolean('is_default').notNull().default(false),
    allow_bots: boolean('allow_bots').notNull().default(true),
    allow_huddles: boolean('allow_huddles').notNull().default(true),
    message_retention_days: integer('message_retention_days'),
    last_message_at: timestamp('last_message_at', { withTimezone: true }),
    last_message_preview: varchar('last_message_preview', { length: 200 }),
    message_count: integer('message_count').notNull().default(0),
    member_count: integer('member_count').notNull().default(0),
    active_huddle_id: uuid('active_huddle_id'),
    // §13 Wave 4 scheduled banter — per-channel quiet-hours policy.
    // Shape: { timezone, allowed_hours:[start,end], weekday_only?, urgency_override? }.
    // Null means no policy (unrestricted posting).
    quiet_hours_policy: jsonb('quiet_hours_policy'),
    // §1 Wave 5 banter subs - per-channel agent subscription gate.
    // Shape: { allow: boolean, allowed_agent_ids: uuid[] }. Default is
    // { allow: false, allowed_agent_ids: [] } - channels opt in by
    // flipping allow=true. allowed_agent_ids is an optional narrower
    // allowlist; empty means "any agent with an agent_policies row".
    agent_subscription_policy: jsonb('agent_subscription_policy').notNull().default({ allow: false, allowed_agent_ids: [] }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('banter_channels_org_slug_idx').on(table.org_id, table.slug),
    index('banter_channels_org_type_idx').on(table.org_id, table.type, table.is_archived),
    index('banter_channels_org_last_msg_idx').on(table.org_id, table.last_message_at),
    index('banter_channels_project_id_idx').on(table.project_id, table.is_archived),
  ],
);
