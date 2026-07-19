// Shared BBB table stubs (auth, users, orgs)
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

// Local Drizzle views of shared platform tables Burn writes directly (spec 3.2).
export { entityLinks } from './entity-links.js';
export { agentProposals } from './agent-proposals.js';

// The 14 burn_* tables land in M2.
