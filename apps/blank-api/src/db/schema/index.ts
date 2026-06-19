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

// Blank-specific tables
export { blankForms } from './blank-forms.js';
export { blankFormFields } from './blank-form-fields.js';
export { blankSubmissions } from './blank-submissions.js';
