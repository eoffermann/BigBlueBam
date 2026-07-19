import { pgTable, uuid, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { organizations, projects } from './bbb-refs.js';
import { burnEngagements } from './burn-engagements.js';

/**
 * Links an engagement to the Bam projects whose work it pays for (spec 3.1).
 *
 * This join table IS Burn's project-scope predicate (spec 2.4 point 6). Burn engagements
 * have no `project_id` column, so the ported Bulwark `project-scope.ts` -- whose documented
 * fallback is that a NULL project passes for every org member -- cannot be used: it would
 * turn the `unlinked` state into org-wide readable and invert the design.
 *
 *   EXISTS (SELECT 1 FROM burn_engagement_projects ep
 *           JOIN project_memberships pm ON pm.project_id = ep.project_id
 *           WHERE ep.engagement_id = :engagement AND pm.user_id = :viewer)
 *
 * There is NO null or empty fallback, so a chain with zero linked projects is
 * `burn.financials.read_all`-only by construction, flagged `unlinked` on the Portfolio
 * Board, and incapable of producing a deny.
 */
export const burnEngagementProjects = pgTable(
  'burn_engagement_projects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    organization_id: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'cascade' }),
    engagement_id: uuid('engagement_id')
      .notNull()
      .references(() => burnEngagements.id, { onDelete: 'cascade' }),
    project_id: uuid('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    created_at: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex('idx_burn_engagement_projects_unique').on(
      table.organization_id,
      table.engagement_id,
      table.project_id,
    ),
    index('idx_burn_engagement_projects_org_project').on(table.organization_id, table.project_id),
    index('idx_burn_engagement_projects_engagement').on(table.engagement_id),
  ],
);
