// Shared BBB table stubs (auth, users, orgs, projects)
export {
  organizations,
  users,
  sessions,
  apiKeys,
  projects,
  organizationMemberships,
  tasks,
  projectMembers,
  permissionGroups,
  accountGroupMemberships,
  impersonationSessions,
} from './bbb-refs.js';

// Board-specific tables
export { boards } from './boards.js';
export { boardElements } from './board-elements.js';
export { boardTemplates } from './board-templates.js';
export { boardVersions } from './board-versions.js';
export { boardTaskLinks } from './board-task-links.js';
export { boardCollaborators } from './board-collaborators.js';
export { boardStars } from './board-stars.js';
export { boardChatMessages } from './board-chat-messages.js';
export { boardIntegrityAudit } from './board-integrity-audit.js';
