// Shared BBB table stubs (auth, users, orgs)
export {
  organizations,
  users,
  projects,
  sessions,
  apiKeys,
  organizationMemberships,
  permissionGroups,
  accountGroupMemberships,
} from './bbb-refs.js';

// Bench-specific tables
export { benchDashboards } from './bench-dashboards.js';
export { benchWidgets } from './bench-widgets.js';
export { benchScheduledReports } from './bench-scheduled-reports.js';
export { benchMaterializedViews } from './bench-materialized-views.js';
export { benchSavedQueries } from './bench-saved-queries.js';
