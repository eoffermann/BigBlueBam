// Shared BBB table stubs (auth, users, orgs, projects)
export {
  organizations,
  users,
  sessions,
  apiKeys,
  projects,
  projectMemberships,
  organizationMemberships,
  permissionGroups,
  accountGroupMemberships,
} from './bbb-refs.js';

// Beacon-specific tables
export { beaconEntries, beaconStatusEnum, beaconVisibilityEnum } from './beacon-entries.js';
export { beaconAgents } from './beacon-agents.js';
export type { BeaconAgentConfig } from './beacon-agents.js';
export { beaconVersions } from './beacon-versions.js';
export { beaconTags } from './beacon-tags.js';
export { beaconLinks, beaconLinkTypeEnum } from './beacon-links.js';
export { beaconExpiryPolicies, expiryScopeEnum } from './beacon-expiry-policies.js';
export { beaconVerifications, verificationTypeEnum, verificationOutcomeEnum } from './beacon-verifications.js';
export { beaconSavedQueries, savedQueryScopeEnum } from './beacon-saved-queries.js';
export { beaconComments } from './beacon-comments.js';
export type { BeaconComment, NewBeaconComment } from './beacon-comments.js';
export { beaconAttachments } from './beacon-attachments.js';
export type { BeaconAttachment, NewBeaconAttachment } from './beacon-attachments.js';
