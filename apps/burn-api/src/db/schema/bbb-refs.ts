// Re-export canonical core table stubs from @bigbluebam/db-stubs.
// Burn needs the auth/org tables for its auth plugin; its own tables live
// in the burn-*.ts modules.
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
