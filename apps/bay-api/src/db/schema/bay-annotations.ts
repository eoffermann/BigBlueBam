import {
  pgTable,
  uuid,
  text,
  jsonb,
  boolean,
  varchar,
  timestamp,
  index,
} from 'drizzle-orm/pg-core';
import { users } from './bbb-refs.js';
import { bayAssetVersions } from './bay-asset-versions.js';

// Bay annotations (Bay master). A time/frame/region/viewpoint-anchored comment
// on a specific version. The anchor jsonb is a discriminated shape, e.g.
//   { type: 'frame', frame: 120 }
//   { type: 'timerange', start, end }
//   { type: 'region', x, y, w, h, frame? }
//   { type: 'viewpoint', camera: {...} }
// Annotations thread via thread_parent_id (nullable; top-level when null) and
// can be marked resolved.
export const bayAnnotations = pgTable(
  'bay_annotations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    version_id: uuid('version_id')
      .notNull()
      .references(() => bayAssetVersions.id, { onDelete: 'cascade' }),
    author_id: uuid('author_id').references(() => users.id, { onDelete: 'set null' }),
    anchor: jsonb('anchor').default({}).notNull(),
    body: text('body').notNull(),
    resolved: boolean('resolved').default(false).notNull(),
    thread_parent_id: uuid('thread_parent_id'),
    // Display name for guest (unauthenticated) comments; null for member
    // comments (their name comes from the users join). (0217)
    guest_name: varchar('guest_name', { length: 120 }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('idx_bay_annotations_version').on(table.version_id)],
);
