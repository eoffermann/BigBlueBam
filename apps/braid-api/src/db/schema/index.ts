// Shared BBB table stubs (auth, users, orgs)
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
} from './bbb-refs.js';

// Braid-specific tables
export { braidProfiles } from './braid-profiles.js';
export { braidIdentities } from './braid-identities.js';
export { braidMatchCandidates } from './braid-match-candidates.js';
export { braidMergeDecisions } from './braid-merge-decisions.js';
export { braidSurvivorshipRules } from './braid-survivorship-rules.js';
export { braidOrgSettings } from './braid-org-settings.js';

// Local Drizzle views of shared platform tables Braid writes directly (spec 3.2).
export { entityLinks } from './entity-links.js';
export { agentProposals } from './agent-proposals.js';
export { dedupeDecisions } from './dedupe-decisions.js';
