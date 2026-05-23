// Shared BBB table stubs (auth, users, orgs, bond contacts)
export {
  organizations,
  users,
  sessions,
  apiKeys,
  organizationMemberships,
  bondContacts,
  permissionGroups,
  accountGroupMemberships,
} from './bbb-refs.js';

// Blast-specific tables
export { blastTemplates } from './blast-templates.js';
export { blastSegments } from './blast-segments.js';
export { blastCampaigns } from './blast-campaigns.js';
export { blastSendLog } from './blast-send-log.js';
export { blastEngagementEvents } from './blast-engagement-events.js';
export { blastUnsubscribes } from './blast-unsubscribes.js';
export { blastSenderDomains } from './blast-sender-domains.js';
