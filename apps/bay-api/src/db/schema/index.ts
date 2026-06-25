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

// Bay-specific tables
export { bayFolders } from './bay-folders.js';
export { bayAssets } from './bay-assets.js';
export { bayAssetVersions } from './bay-asset-versions.js';
export { bayAnnotations } from './bay-annotations.js';
export { bayReviewDecisions } from './bay-review-decisions.js';
