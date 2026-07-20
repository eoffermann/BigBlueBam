// Bursar Drizzle schema barrel. 25 bursar_* tables mirroring migrations 0247-0250, with
// per-table RLS policies added in 0251. Money is bigint minor units + explicit currency
// varchar(3); cross-app refs (bin/bond/braid/bill/agent_proposals) are plain uuid columns
// with NO cross-schema FK (spec 6.1).

// Shared BBB table stubs (auth, users, orgs) - FK targets only.
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

// Core (migration 0247)
export { bursarVendors } from './bursar-vendors.js';
export { bursarPayeeAliases } from './bursar-payee-aliases.js';
export { bursarRequests } from './bursar-requests.js';
export { bursarExtractionRuns } from './bursar-extraction-runs.js';
export { bursarScopeNodes } from './bursar-scope-nodes.js';
export { bursarScopeLibrary } from './bursar-scope-library.js';
export { bursarOrgSettings } from './bursar-org-settings.js';

// Offers + coverage (migration 0248)
export { bursarOffers } from './bursar-offers.js';
export { bursarLevelingRuns } from './bursar-leveling-runs.js';
export { bursarOfferLines } from './bursar-offer-lines.js';
export { bursarOfferCoverage } from './bursar-offer-coverage.js';
export { bursarLineNodeMatches } from './bursar-line-node-matches.js';
export { bursarLevelingWindowResults } from './bursar-leveling-window-results.js';
export { bursarOfferTotals } from './bursar-offer-totals.js';

// Awards + baseline + spend (migration 0249)
export { bursarAwards } from './bursar-awards.js';
export { bursarBaselineItems } from './bursar-baseline-items.js';
export { bursarBaselineItemNodes } from './bursar-baseline-item-nodes.js';
export { bursarSpendImports } from './bursar-spend-imports.js';
export { bursarSpendEvents } from './bursar-spend-events.js';

// Detectors + drafts (migration 0250)
export { bursarMismatches } from './bursar-mismatches.js';
export { bursarRenewals } from './bursar-renewals.js';
export { bursarGateChecks } from './bursar-gate-checks.js';
export { bursarIngestEvents } from './bursar-ingest-events.js';
export { bursarDetectorFeedback } from './bursar-detector-feedback.js';
export { bursarDrafts } from './bursar-drafts.js';
