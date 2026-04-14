import {
  pgTable,
  uuid,
  varchar,
  text,
  jsonb,
  timestamp,
  integer,
  index,
} from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';
import { users } from './users.js';

/**
 * Canonical mirror of apps/bond-api/src/db/schema/bond-contacts.ts.
 */
export const bondContacts = pgTable(
  'bond_contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),

    first_name: varchar('first_name', { length: 100 }),
    last_name: varchar('last_name', { length: 100 }),
    email: varchar('email', { length: 255 }),
    phone: varchar('phone', { length: 50 }),
    title: varchar('title', { length: 150 }),
    avatar_url: text('avatar_url'),

    lifecycle_stage: varchar('lifecycle_stage', { length: 30 }).notNull().default('lead'),
    lead_source: varchar('lead_source', { length: 60 }),
    lead_score: integer('lead_score').default(0),

    address_line1: varchar('address_line1', { length: 255 }),
    address_line2: varchar('address_line2', { length: 255 }),
    city: varchar('city', { length: 100 }),
    state_region: varchar('state_region', { length: 100 }),
    postal_code: varchar('postal_code', { length: 20 }),
    country: varchar('country', { length: 2 }),

    custom_fields: jsonb('custom_fields').default({}).notNull(),

    owner_id: uuid('owner_id').references(() => users.id, { onDelete: 'set null' }),

    last_contacted_at: timestamp('last_contacted_at', { withTimezone: true }),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_bond_contacts_org').on(table.organization_id),
    index('idx_bond_contacts_email').on(table.organization_id, table.email),
    index('idx_bond_contacts_lifecycle').on(table.organization_id, table.lifecycle_stage),
    index('idx_bond_contacts_owner').on(table.owner_id),
    index('idx_bond_contacts_score').on(table.organization_id, table.lead_score),
  ],
);
