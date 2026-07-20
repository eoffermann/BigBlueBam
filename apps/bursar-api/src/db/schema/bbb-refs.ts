// Re-export canonical core table stubs from @bigbluebam/db-stubs.
// Bursar needs the auth/org tables for its auth plugin and FK targets; its own
// tables live in the bursar-*.ts modules. Cross-app refs (bin/bond/braid/bill)
// are plain uuid columns with NO cross-schema FK, per spec 6.1.
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
