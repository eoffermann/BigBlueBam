// Re-export canonical core table stubs from @bigbluebam/db-stubs.
// Bulwark needs the auth/org tables for its auth plugin; its own tables live
// in the bulwark-*.ts modules.
export {
  organizations,
  users,
  projects,
  sessions,
  apiKeys,
  organizationMemberships,
  projectMemberships,
  permissionGroups,
  accountGroupMemberships,
  impersonationSessions,
} from '@bigbluebam/db-stubs';
