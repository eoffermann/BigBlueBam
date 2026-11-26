// Bastion Drizzle schema barrel. M1 carries only the shared platform stubs the auth plugin
// needs; the bastion_* tables arrive with their migrations at M2.
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
} from './bbb-refs.js';
