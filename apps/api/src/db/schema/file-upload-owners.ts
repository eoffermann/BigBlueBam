import { pgTable, text, uuid, varchar, timestamp, index } from 'drizzle-orm/pg-core';
import { organizations } from './organizations.js';

/**
 * Which org owns each legacy `/files/` upload (#142, migration 0310). Written by the Bam api's
 * POST /upload (`uploads/...`) and helpdesk-api's POST /helpdesk/upload (`helpdesk/...`); GET
 * /files serves those keys only to a caller whose active org owns them.
 */
export const fileUploadOwners = pgTable(
  'file_upload_owners',
  {
    storage_key: text('storage_key').primaryKey(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    /** 'bam' | 'helpdesk' */
    source: varchar('source', { length: 20 }).notNull(),
    /** users.id for 'bam', helpdesk_users.id for 'helpdesk'; null for backfilled rows. */
    uploaded_by: uuid('uploaded_by'),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('file_upload_owners_org_idx').on(table.org_id)],
);
