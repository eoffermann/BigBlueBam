import { pgTable, uuid, text, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';

// Issue #156 (migration 0269): one row per storage key issued by
// POST /v1/files/upload or /v1/files/presigned-upload, naming the org and user it
// was issued to. Posting a message consumes (deletes) the row, so a key can be
// attached once, by its uploader, in their org.
export const banterUploadGrants = pgTable(
  'banter_upload_grants',
  {
    storage_key: text('storage_key').primaryKey(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    uploader_id: uuid('uploader_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [index('banter_upload_grants_expires_idx').on(table.expires_at)],
);
