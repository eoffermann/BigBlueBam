/**
 * Re-exports canonical Bam table declarations from @bigbluebam/db-stubs.
 *
 * Wave 1.D of the 2026-04-13 push consolidated the 13 hand-maintained
 * `bbb-refs.ts` copies behind a single shared package. Adding a local
 * `pgTable(...)` declaration here will trip
 * `scripts/check-no-local-bbb-refs.mjs` in CI - update the canonical file
 * under `packages/db-stubs/src` instead.
 *
 * bond-api's own `bond-deals.ts` / `bond-contacts.ts` remain the canonical
 * source of truth for those tables. The db-stubs package ships mirrored
 * copies for cross-app consumers (bill-api, blast-api) only; bond-api
 * itself never imports them via db-stubs to avoid a duplicate Drizzle
 * table declaration collision.
 */
export {
  organizations,
  users,
  sessions,
  apiKeys,
  organizationMemberships,
} from '@bigbluebam/db-stubs';
