// Re-export canonical core table stubs from @bigbluebam/db-stubs.
// Blueprint references these for FK and auth-plugin lookups, but does
// not own any of them.
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
