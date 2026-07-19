import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  numeric,
  timestamp,
  customType,
  index,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './bbb-refs.js';
import { burnEngagements } from './burn-engagements.js';
import { burnWorkItems } from './burn-work-items.js';
import { burnDeliverables } from './burn-deliverables.js';

// Same tsvector idiom as burn-deliverables.ts (braid-profiles.ts:15-18).
const tsvector = customType<{ data: string }>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * Every human correction of the classifier (spec 3.1). NEVER PURGED: this is the exemplar
 * corpus that tunes attribution, and discarding it discards the org's accumulated judgment.
 *
 * `text_snapshot` is PII-redacted. `search_tsv` over it is subject to the same rule as
 * `burn_deliverables.search_tsv` (R3-S4): no member-reachable endpoint may filter, sort,
 * rank, or highlight on it, because a searchable floored field is not floored.
 *
 * `search_tsv` is a GENERATED ALWAYS ... STORED column defined in migration 0240 as
 * `to_tsvector('english', coalesce(text_snapshot, ''))` -- coalesced, because a bare
 * concatenation over a nullable column yields NULL and guts recall on the shipped path.
 */
export const burnClassifierFeedback = pgTable(
  'burn_classifier_feedback',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    engagement_id: uuid('engagement_id').references(() => burnEngagements.id, {
      onDelete: 'set null',
    }),
    work_item_id: uuid('work_item_id').references(() => burnWorkItems.id, { onDelete: 'set null' }),
    // accept | reject | reclassify | mark_unscoped | mark_scoped | mark_non_billable
    decision_kind: varchar('decision_kind', { length: 24 }).notNull(),
    proposed_deliverable_id: uuid('proposed_deliverable_id').references(() => burnDeliverables.id, {
      onDelete: 'set null',
    }),
    corrected_deliverable_id: uuid('corrected_deliverable_id').references(
      () => burnDeliverables.id,
      { onDelete: 'set null' },
    ),
    proposed_confidence: numeric('proposed_confidence', { precision: 5, scale: 2 }),
    text_snapshot: text('text_snapshot'),
    search_tsv: tsvector('search_tsv'),
    qdrant_point_id: uuid('qdrant_point_id'),
    qdrant_synced_at: timestamp('qdrant_synced_at', { withTimezone: true }),
    decided_by: uuid('decided_by')
      .notNull()
      .references(() => users.id),
    vocabulary_version: integer('vocabulary_version').notNull().default(0),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index('idx_burn_classifier_feedback_org_engagement').on(
      table.organization_id,
      table.engagement_id,
      table.created_at,
    ),
    index('idx_burn_classifier_feedback_org_kind').on(
      table.organization_id,
      table.decision_kind,
      table.created_at,
    ),
  ],
);
