import {
  pgTable,
  uuid,
  text,
  varchar,
  jsonb,
  numeric,
  boolean,
  timestamp,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { braidProfiles } from './braid-profiles.js';

// One row per source-app record mapped into a golden profile. `id` is the immutable
// stable atom (survives merge/split) used as the dedupe_decisions suppression key
// (spec 2.3). No cross-schema FK on source_id: the source is a dotted type + uuid,
// like entity_links.dst_type/dst_id.
export const braidIdentities = pgTable(
  'braid_identities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    profile_id: uuid('profile_id')
      .notNull()
      .references(() => braidProfiles.id, { onDelete: 'cascade' }),
    source_type: text('source_type').notNull(),
    source_id: uuid('source_id').notNull(),
    match_keys: jsonb('match_keys').notNull().default('{}'),
    raw_attributes: jsonb('raw_attributes').notNull().default('{}'),
    source_synced_at: timestamp('source_synced_at', { withTimezone: true }),
    needs_rescan: boolean('needs_rescan').notNull().default(false),
    link_confidence: numeric('link_confidence', { precision: 5, scale: 2 }),
    link_evidence: jsonb('link_evidence').notNull().default('{}'),
    link_kind: varchar('link_kind', { length: 8 }).notNull().default('auto'),
    linked_by: uuid('linked_by').references(() => users.id, { onDelete: 'set null' }),
    linked_at: timestamp('linked_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_braid_identities_org_source').on(
      table.organization_id,
      table.source_type,
      table.source_id,
    ),
    index('idx_braid_identities_profile').on(table.profile_id),
    index('idx_braid_identities_org_type').on(table.organization_id, table.source_type),
    index('idx_braid_identities_synced').on(table.source_synced_at),
  ],
);
