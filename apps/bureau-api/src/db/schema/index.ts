// Shared BBB table stubs (auth, users, orgs, projects).
// These are referenced by the auth plugin and any cross-cutting domain queries
// and are NOT bureau-specific — they mirror the same stubs other -api services
// use until @bigbluebam/db-stubs is enriched enough to replace them.
export {
  organizations,
  users,
  sessions,
  apiKeys,
  projects,
  organizationMemberships,
  tasks,
  projectMembers,
  permissionGroups,
  accountGroupMemberships,
} from './bbb-refs.js';

// Bureau-specific tables — workstream 1's migrations agent is authoring
// ./bureau.ts (floors, rooms, offices, bookings, knocks, summons, presence,
// settings) in parallel. Re-enable this re-export once that file lands so
// route handlers can `import { floors, rooms, ... } from '../db/schema/index.js'`.
// export * from './bureau.js';
