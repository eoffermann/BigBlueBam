import { pgTable, uuid, text, jsonb, timestamp, uniqueIndex, index } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { blipTrackedApps } from './blip-tracked-apps.js';

/**
 * blip_ingest_keys: a write-only ingest credential for one tracked_app (Blip
 * §10). The full token (blip_<key_id>_<secret>) is shown once at creation; only
 * an HMAC of the secret is stored. Embedded in shipped clients, so low-trust:
 * append-only to its one app, individually revocable, own rate limit.
 */
export const blipIngestKeys = pgTable(
  'blip_ingest_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    tracked_app_id: uuid('tracked_app_id')
      .notNull()
      .references(() => blipTrackedApps.id, { onDelete: 'cascade' }),
    key_id: text('key_id').notNull(), // public lookup id embedded in the token
    secret_hmac: text('secret_hmac').notNull(), // HMAC-SHA256(secret, server_pepper)
    last4: text('last4').notNull(),
    fingerprint: text('fingerprint').notNull(),
    label: text('label'),
    status: text('status').notNull().default('active'), // 'active' | 'suspended' | 'revoked'
    rate_limit_override: jsonb('rate_limit_override'),
    created_by: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    last_used_at: timestamp('last_used_at', { withTimezone: true }),
    suspended_at: timestamp('suspended_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('blip_ingest_keys_key_id').on(t.key_id),
    index('blip_ingest_keys_app_idx').on(t.tracked_app_id),
  ],
);
