/**
 * Re-exports canonical Bam table declarations from @bigbluebam/db-stubs.
 *
 * Wave 1.D of the 2026-04-13 push consolidated the 13 hand-maintained
 * `bbb-refs.ts` copies behind a single shared package. Adding a local
 * `pgTable(...)` declaration here will trip
 * `scripts/check-no-local-bbb-refs.mjs` in CI - update the canonical file
 * under `packages/db-stubs/src` instead, or annotate the override with
 * `// noqa: local-bbb-ref <reason>` if it is a transitional stub.
 *
 * DRIFT: brief-api/services/link.service.ts reads `tasks.org_id`, but the
 * canonical `tasks` table (apps/api/src/db/schema/tasks.ts) has NO
 * `org_id` column - task org is derived via `project_id -> projects.org_id`
 * in Bam canonical. The live DB matches the canonical shape, so the brief
 * code path is broken at runtime anyway; this stub keeps the build compiling
 * while the Brief Wave 2 plan removes the consumer reference. Tracked
 * against Brief_Plan.md (2026-04-13 revised push). Remove this override
 * and fix the consumer once that plan lands.
 */
import { pgTable, uuid, varchar } from 'drizzle-orm/pg-core';
import { organizations as _organizations, projects as _projects } from '@bigbluebam/db-stubs';

export {
  organizations,
  users,
  sessions,
  apiKeys,
  projects,
  projectMemberships,
  organizationMemberships,
  beaconEntries,
} from '@bigbluebam/db-stubs';

// Transitional local override - DO NOT copy this pattern. See module doc.
// eslint-disable-next-line -- local-bbb-ref noqa
export const tasks = pgTable('tasks', { // noqa: local-bbb-ref brief-api link.service reads tasks.org_id (canonical has no such column)
  id: uuid('id').primaryKey().defaultRandom(),
  org_id: uuid('org_id')
    .notNull()
    .references(() => _organizations.id),
  project_id: uuid('project_id')
    .notNull()
    .references(() => _projects.id),
  title: varchar('title', { length: 500 }).notNull(),
});
