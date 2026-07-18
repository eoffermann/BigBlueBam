import {
  pgTable,
  uuid,
  varchar,
  jsonb,
  integer,
  numeric,
  boolean,
  timestamp,
  customType,
  index,
} from 'drizzle-orm/pg-core';
import { organizations } from './bbb-refs.js';

// Drizzle has no first-class tsvector column kind (mirrors helpdesk tickets.ts).
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

// The golden record. One row per resolved real-world person or company.
// PII columns (display_name/primary_email/primary_phone/attributes/email_suppressed/
// confidence/identity_count) are an INTERNAL WORKER CACHE, re-assembled per viewer on
// read (spec 2.1). company_profile_id and merged_into_id are self-FKs declared in the
// migration (not here) to avoid a circular self-reference in Drizzle.
export const braidProfiles = pgTable(
  'braid_profiles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 8 }).notNull(),
    display_name: varchar('display_name', { length: 320 }),
    primary_email: varchar('primary_email', { length: 320 }),
    primary_phone: varchar('primary_phone', { length: 64 }),
    email_suppressed: boolean('email_suppressed').notNull().default(false),
    company_profile_id: uuid('company_profile_id'),
    attributes: jsonb('attributes').notNull().default('{}'),
    identity_count: integer('identity_count').notNull().default(0),
    confidence: numeric('confidence', { precision: 5, scale: 2 }),
    status: varchar('status', { length: 12 }).notNull().default('active'),
    merged_into_id: uuid('merged_into_id'),
    search_vector: tsvector('search_vector'),
    qdrant_point_id: uuid('qdrant_point_id'),
    qdrant_synced_at: timestamp('qdrant_synced_at', { withTimezone: true }),
    last_event_published_at: timestamp('last_event_published_at', { withTimezone: true }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_braid_profiles_org_kind_status').on(
      table.organization_id,
      table.kind,
      table.status,
    ),
    index('idx_braid_profiles_org_email').on(table.organization_id, table.primary_email),
    index('idx_braid_profiles_org_phone').on(table.organization_id, table.primary_phone),
    index('idx_braid_profiles_merged_into').on(table.merged_into_id),
    index('idx_braid_profiles_qdrant_synced').on(table.qdrant_synced_at),
    index('idx_braid_profiles_event_published').on(table.last_event_published_at),
  ],
);
