// Re-export canonical core table stubs from @bigbluebam/db-stubs.
// This service needs no extra columns beyond what the shared package provides.
export {
  organizations,
  users,
  sessions,
  apiKeys,
  projects,
  organizationMemberships,
  permissionGroups,
  accountGroupMemberships,
} from '@bigbluebam/db-stubs';
