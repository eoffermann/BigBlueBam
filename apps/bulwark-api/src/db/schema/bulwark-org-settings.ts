import {
  pgTable,
  uuid,
  varchar,
  numeric,
  boolean,
  integer,
  jsonb,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

// Per-org tunables (spec 3.1, modeled on basis_org_settings). One row per org.
// inbox_retention_days is enforced >= discharged_deadline_retention_days at the settings
// layer so a late redelivery cannot re-arm a purged clock (STJ7). auto_draft_notices is off
// by default (D5).
export const bulwarkOrgSettings = pgTable(
  'bulwark_org_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    default_timezone: varchar('default_timezone', { length: 64 }).notNull().default('UTC'),
    auto_confirm_threshold: numeric('auto_confirm_threshold', { precision: 5, scale: 2 })
      .notNull()
      .default('0.95'),
    radar_lead_times: jsonb('radar_lead_times')
      .notNull()
      .default({ critical_hours: 24, high_hours: 72, medium_hours: 168 }),
    auto_draft_notices: boolean('auto_draft_notices').notNull().default(false),
    auto_draft_max_per_sweep: integer('auto_draft_max_per_sweep').notNull().default(20),
    notice_llm_daily_cap: integer('notice_llm_daily_cap').notNull().default(100),
    chase_cadence_days: integer('chase_cadence_days').notNull().default(7),
    coi_expiry_lead_days: integer('coi_expiry_lead_days').notNull().default(30),
    discharged_deadline_retention_days: integer('discharged_deadline_retention_days')
      .notNull()
      .default(365),
    inbox_retention_days: integer('inbox_retention_days').notNull().default(400),
    llm_provider_id: uuid('llm_provider_id'),
    last_radar_sweep_at: timestamp('last_radar_sweep_at', { withTimezone: true }),
    updated_by: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updated_at: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [uniqueIndex('idx_bulwark_org_settings_org').on(table.organization_id)],
);
