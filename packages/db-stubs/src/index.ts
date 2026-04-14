/**
 * @bigbluebam/db-stubs
 *
 * Canonical drizzle `pgTable` declarations for Bam tables (and a small set of
 * cross-app-owned tables like bond_deals, bond_contacts, beacon_entries) that
 * non-Bam services need to reference via foreign keys or queries. Replaces
 * the 13 hand-maintained `apps/<svc>/src/db/schema/bbb-refs.ts` copies that
 * had drifted out of sync with the live database.
 *
 * When a Bam schema file changes, mirror the change here and let the CI
 * guard (scripts/check-no-local-bbb-refs.mjs) ensure no service is left
 * declaring its own divergent copy.
 */
export { organizations } from './organizations.js';
export { users } from './users.js';
export { sessions } from './sessions.js';
export { apiKeys } from './api-keys.js';
export { organizationMemberships } from './organization-memberships.js';
export { projects } from './projects.js';
export { projectMemberships, projectMembers } from './project-memberships.js';
export { phases } from './phases.js';
export { tasks } from './tasks.js';
export { labels } from './labels.js';
export { timeEntries } from './time-entries.js';
export { bondDeals } from './bond-deals.js';
export { bondContacts } from './bond-contacts.js';
export { beaconEntries } from './beacon-entries.js';
