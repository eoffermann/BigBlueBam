/**
 * Re-exports canonical Bam table declarations from @bigbluebam/db-stubs.
 *
 * Wave 1.D of the 2026-04-13 push consolidated the 13 hand-maintained
 * `bbb-refs.ts` copies behind a single shared package. Adding a local
 * `pgTable(...)` declaration here will trip
 * `scripts/check-no-local-bbb-refs.mjs` in CI - update the canonical file
 * under `packages/db-stubs/src` instead.
 *
 * Note: beacon-api's own `beacon-entries.ts` remains the canonical source
 * for the `beacon_entries` table and is loaded directly from
 * `apps/beacon-api/src/db/schema/beacon-entries.ts`. The db-stubs package
 * ships a varchar-based mirror for cross-app consumers (e.g. brief-api)
 * only; beacon-api never re-exports that mirror because it would collide
 * with the local pgEnum declarations.
 */
export {
  organizations,
  users,
  sessions,
  apiKeys,
  projects,
  projectMemberships,
  organizationMemberships,
} from '@bigbluebam/db-stubs';
