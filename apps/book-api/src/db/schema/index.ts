// Shared BBB table stubs (auth, users, orgs, projects)
export {
  organizations,
  users,
  sessions,
  apiKeys,
  organizationMemberships,
  projects,
  permissionGroups,
  accountGroupMemberships,
} from './bbb-refs.js';

// Book-specific tables
export { bookCalendars } from './book-calendars.js';
export { bookEvents } from './book-events.js';
export { bookEventAttendees } from './book-event-attendees.js';
export { bookWorkingHours } from './book-working-hours.js';
export { bookBookingPages } from './book-booking-pages.js';
export { bookExternalConnections } from './book-external-connections.js';
export { bookExternalEvents } from './book-external-events.js';
export { bookIcalTokens } from './book-ical-tokens.js';
