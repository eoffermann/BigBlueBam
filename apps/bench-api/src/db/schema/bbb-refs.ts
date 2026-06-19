// Re-export canonical core table stubs from @bigbluebam/db-stubs.
// This service needs no extra columns beyond what the shared package provides.
export {
  organizations,
  users,
  projects,
  sessions,
  apiKeys,
  organizationMemberships,
  permissionGroups,
  accountGroupMemberships,
  impersonationSessions,
} from '@bigbluebam/db-stubs';
