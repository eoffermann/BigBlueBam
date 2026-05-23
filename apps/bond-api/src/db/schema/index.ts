// Shared BBB table stubs (auth, users, orgs)
export {
  organizations,
  users,
  sessions,
  apiKeys,
  organizationMemberships,
  permissionGroups,
  accountGroupMemberships,
} from './bbb-refs.js';

// Bond-specific tables
export { bondContacts } from './bond-contacts.js';
export { bondCompanies } from './bond-companies.js';
export { bondContactCompanies } from './bond-contact-companies.js';
export { bondPipelines } from './bond-pipelines.js';
export { bondPipelineStages } from './bond-pipeline-stages.js';
export { bondDeals } from './bond-deals.js';
export { bondDealContacts } from './bond-deal-contacts.js';
export { bondActivities } from './bond-activities.js';
export { bondDealStageHistory } from './bond-deal-stage-history.js';
export { bondLeadScoringRules } from './bond-lead-scoring-rules.js';
export { bondCustomFieldDefinitions } from './bond-custom-field-definitions.js';
export { bondImportMappings } from './bond-import-mappings.js';

// Shared cross-app dedupe-decisions table (migration 0136, Wave 5 §7)
export { dedupeDecisions } from './dedupe-decisions.js';
