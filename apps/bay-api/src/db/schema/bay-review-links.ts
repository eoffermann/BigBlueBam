import {
  pgTable,
  uuid,
  varchar,
  boolean,
  integer,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { bayAssets } from './bay-assets.js';

// Bay public review share links (0217). A reviewer mints a token that an
// unauthenticated guest opens (at /bay/r/:token) to view the review and
// optionally comment. The token is the sole bearer of access — long, random,
// revocable (revoked_at), and optionally time-limited (expires_at).
export const bayReviewLinks = pgTable(
  'bay_review_links',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    org_id: uuid('org_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    asset_id: uuid('asset_id')
      .notNull()
      .references(() => bayAssets.id, { onDelete: 'cascade' }),
    // DB default mints 24 random bytes hex (48 chars); set server-side too.
    token: varchar('token', { length: 64 }).notNull().unique(),
    allow_comments: boolean('allow_comments').notNull().default(true),
    created_by: uuid('created_by')
      .notNull()
      .references(() => users.id),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    expires_at: timestamp('expires_at', { withTimezone: true }),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
    last_viewed_at: timestamp('last_viewed_at', { withTimezone: true }),
    view_count: integer('view_count').notNull().default(0),
  },
  (table) => [
    index('idx_bay_review_links_token').on(table.token),
    index('idx_bay_review_links_org').on(table.org_id),
    index('idx_bay_review_links_asset').on(table.asset_id),
  ],
);
