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

// Bulwark-specific tables (spec 3.1)
export { bulwarkContracts } from './bulwark-contracts.js';
export { bulwarkObligations } from './bulwark-obligations.js';
export { bulwarkIngestEvents } from './bulwark-ingest-events.js';
export { bulwarkNoticeDeadlines } from './bulwark-notice-deadlines.js';
export { bulwarkWaiverRisks } from './bulwark-waiver-risks.js';
export { bulwarkVendorTiers } from './bulwark-vendor-tiers.js';
export { bulwarkComplianceDocs } from './bulwark-compliance-docs.js';
export { bulwarkExtractionRuns } from './bulwark-extraction-runs.js';
export { bulwarkOrgSettings } from './bulwark-org-settings.js';

// Local Drizzle views of shared platform tables Bulwark writes directly (spec 3.2).
export { entityLinks } from './entity-links.js';
export { agentProposals } from './agent-proposals.js';
