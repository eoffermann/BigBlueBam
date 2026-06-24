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

// Bin-specific tables
export { binFolders } from './bin-folders.js';
export { binAssets } from './bin-assets.js';
export { binAssetVersions } from './bin-asset-versions.js';
