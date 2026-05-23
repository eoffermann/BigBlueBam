// Shared BBB table stubs (auth, users, orgs, projects, tasks, beacon_entries)
export {
  organizations,
  users,
  sessions,
  apiKeys,
  projects,
  projectMemberships,
  organizationMemberships,
  tasks,
  beaconEntries,
  permissionGroups,
  accountGroupMemberships,
} from './bbb-refs.js';

// Brief-specific tables
export { briefTemplates } from './brief-templates.js';
export { briefFolders } from './brief-folders.js';
export { briefDocuments, briefDocumentStatusEnum, briefVisibilityEnum } from './brief-documents.js';
export { briefVersions } from './brief-versions.js';
export { briefComments, briefCommentReactions } from './brief-comments.js';
export { briefEmbeds } from './brief-embeds.js';
export {
  briefTaskLinks,
  briefBeaconLinks,
  briefTaskLinkTypeEnum,
  briefBeaconLinkTypeEnum,
} from './brief-links.js';
export {
  briefCollaborators,
  briefStars,
  briefCollaboratorPermissionEnum,
} from './brief-collaborators.js';
