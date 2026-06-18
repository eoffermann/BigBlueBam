import {
  pgTable,
  uuid,
  varchar,
  integer,
  bigserial,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { organizations, users } from './bbb-refs.js';

/**
 * Banter Feed schema (docs/plans/banter-feed-design-document.md).
 *
 * Three tables back the ranked, top-down, cross-app feed:
 *  - banter_feed_subscriptions: the default-on follow/mute hierarchy (§5). Only
 *     deviations (unfollowed/muted, plus rare explicit re-following) are stored.
 *  - banter_feed_entries: the per-(user, entity) candidate index (§7.1). The
 *     fan-in job upserts membership + freshness; the read path ranks at read time.
 *  - banter_feed_weights: two-level platform/org tunable weight sets (§7.2).
 *
 * Migration: infra/postgres/migrations/0201_banter_feed.sql (keep in lockstep).
 */

// §5.4 — the follow/mute hierarchy. scope_type ∈ item|channel|project|source.
export const banterFeedSubscriptions = pgTable(
  'banter_feed_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope_type: varchar('scope_type', { length: 16 }).notNull(),
    scope_source: varchar('scope_source', { length: 16 }).notNull(),
    scope_id: uuid('scope_id'),
    state: varchar('state', { length: 12 }).notNull().default('following'),
    origin: varchar('origin', { length: 8 }).notNull().default('manual'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // COALESCE folds the NULL scope_id (source-level rows) onto a sentinel so a
    // source subscription is a single unique key per (user, source).
    uniqueIndex('banter_feed_subs_unique').on(
      table.user_id,
      table.scope_type,
      table.scope_source,
      sql`COALESCE(${table.scope_id}, '00000000-0000-0000-0000-000000000000'::uuid)`,
    ),
    index('banter_feed_subs_lookup').on(
      table.user_id,
      table.scope_source,
      table.scope_type,
    ),
  ],
);

// §7.1 — per-(user, entity) candidate index. One row per (user, entity).
export const banterFeedEntries = pgTable(
  'banter_feed_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    user_id: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    category: varchar('category', { length: 48 }).notNull(),
    entity_type: varchar('entity_type', { length: 48 }).notNull(),
    entity_id: uuid('entity_id').notNull(),
    root_entity_type: varchar('root_entity_type', { length: 48 }),
    root_entity_id: uuid('root_entity_id'),
    source: varchar('source', { length: 16 }).notNull(),
    channel_id: uuid('channel_id'),
    project_id: uuid('project_id'),
    published_at: timestamp('published_at', { withTimezone: true }).notNull(),
    last_activity_at: timestamp('last_activity_at', { withTimezone: true }).notNull(),
    relationship_flags: integer('relationship_flags').notNull().default(0),
    interaction_flags: integer('interaction_flags').notNull().default(0),
    engagement_count: integer('engagement_count').notNull().default(0),
    seen_at: timestamp('seen_at', { withTimezone: true }),
    dismissed_at: timestamp('dismissed_at', { withTimezone: true }),
    seq: bigserial('seq', { mode: 'number' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('banter_feed_entries_unique').on(
      table.user_id,
      table.entity_type,
      table.entity_id,
    ),
    index('banter_feed_entries_ranking')
      .on(table.user_id, table.last_activity_at.desc())
      .where(sql`dismissed_at IS NULL`),
    index('banter_feed_entries_seq').on(table.org_id, table.seq.desc()),
  ],
);

// §7.2 — two-level tunable weight sets. scope ∈ platform|org.
export const banterFeedWeights = pgTable(
  'banter_feed_weights',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    scope: varchar('scope', { length: 8 }).notNull(),
    org_id: uuid('org_id').references(() => organizations.id, { onDelete: 'cascade' }),
    weights: jsonb('weights').notNull(),
    version: integer('version').notNull().default(1),
    updated_by: uuid('updated_by').references(() => users.id),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('banter_feed_weights_platform')
      .on(table.scope)
      .where(sql`scope = 'platform'`),
    uniqueIndex('banter_feed_weights_org')
      .on(table.org_id)
      .where(sql`scope = 'org'`),
  ],
);
