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

// Burn-specific tables (spec 3.1). 14 tables.
export { burnEngagements } from './burn-engagements.js';
export { burnEngagementProjects } from './burn-engagement-projects.js';
export { burnDeliverables } from './burn-deliverables.js';
export { burnWorkItems } from './burn-work-items.js';
export { burnAttributions } from './burn-attributions.js';
export { burnAttributionRules } from './burn-attribution-rules.js';
export { burnPrechecks } from './burn-prechecks.js';
export { burnVariances } from './burn-variances.js';
export { burnClassifierFeedback } from './burn-classifier-feedback.js';
export { burnCostRates } from './burn-cost-rates.js';
export { burnEngagementRollups } from './burn-engagement-rollups.js';
export { burnIngestEvents } from './burn-ingest-events.js';
export { burnExtractionRuns } from './burn-extraction-runs.js';
export { burnOrgSettings } from './burn-org-settings.js';

// Local Drizzle views of shared platform tables Burn writes directly (spec 3.2).
export { entityLinks } from './entity-links.js';
export { agentProposals } from './agent-proposals.js';
