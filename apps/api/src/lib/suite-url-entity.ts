/**
 * What a suite URL names, for POST /internal/can-read (#300). Bureau asks "may this user learn
 * that someone is at, or be summoned to, this URL?" for every Launchpad app except Board and
 * Brief (which answer for their own URLs), and the answer must fail CLOSED:
 *
 *   entity       the URL is an entity page the can_access visibility service knows how to judge
 *                (a deal, an invoice, a ticket, a task, ...): answer through preflightAccess.
 *   no_resource  the URL is an app home or a list/settings page whose every path segment is a
 *                known static page word: nothing entity-scoped beyond org membership.
 *   unsupported  anything else (an id we cannot map, a slug, a name): DENY. A URL segment can be
 *                an entity id or a name (a Beacon slug, a Banter channel slug), so an unknown
 *                segment is never assumed harmless.
 *
 * Entity shapes mirror each SPA's router (apps/<app>/src/app.tsx). Only UUID ids are mapped;
 * the visibility service is keyed by id.
 */
import { launchpadAppFromUrl, type VisibilityEntityType } from '@bigbluebam/shared';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const UUID_RE = new RegExp(`^${UUID}$`, 'i');

type EntityRule = { re: RegExp; type: VisibilityEntityType };

/** Path (after the /<app> prefix) to entity, per app. First match wins. */
const ENTITY_RULES: Record<string, EntityRule[]> = {
  bam: [
    { re: new RegExp(`/tasks/(${UUID})(?:/|$)`, 'i'), type: 'bam.task' },
    { re: new RegExp(`/sprints/(${UUID})(?:/|$)`, 'i'), type: 'bam.sprint' },
    { re: new RegExp(`/projects/(${UUID})(?:/|$)`, 'i'), type: 'bam.project' },
  ],
  bond: [
    { re: new RegExp(`^/deals/(${UUID})/?$`, 'i'), type: 'bond.deal' },
    { re: new RegExp(`^/contacts/(${UUID})/?$`, 'i'), type: 'bond.contact' },
    { re: new RegExp(`^/companies/(${UUID})/?$`, 'i'), type: 'bond.company' },
  ],
  bill: [
    { re: new RegExp(`^/invoices/(${UUID})(?:/edit)?/?$`, 'i'), type: 'bill.invoice' },
    { re: new RegExp(`^/clients/(${UUID})/?$`, 'i'), type: 'bill.client' },
  ],
  beacon: [{ re: new RegExp(`^/(${UUID})(?:/edit)?/?$`, 'i'), type: 'beacon.entry' }],
  helpdesk: [{ re: new RegExp(`/tickets/(${UUID})/?$`, 'i'), type: 'helpdesk.ticket' }],
  bearing: [{ re: new RegExp(`^/goals/(${UUID})/?$`, 'i'), type: 'bearing.goal' }],
  blueprint: [{ re: new RegExp(`^/d/(${UUID})/?$`, 'i'), type: 'blueprint.diagram' }],
  blank: [{ re: new RegExp(`^/forms/(${UUID})(?:/[a-z]+)?/?$`, 'i'), type: 'blank.form' }],
  bolt: [{ re: new RegExp(`^/automations/(${UUID})(?:/executions)?/?$`, 'i'), type: 'bolt.rule' }],
  book: [{ re: new RegExp(`^/events/(${UUID})(?:/edit)?/?$`, 'i'), type: 'book.event' }],
  bin: [{ re: new RegExp(`^/assets/(${UUID})/?$`, 'i'), type: 'bin.asset' }],
  bay: [{ re: new RegExp(`^/assets/(${UUID})/?$`, 'i'), type: 'bay.asset' }],
  braid: [{ re: new RegExp(`^/profiles/(${UUID})/?$`, 'i'), type: 'braid.profile' }],
};

/**
 * Path segments that name a page, never an entity. A URL whose every segment after the app is
 * in this set is an app home / list / settings page.
 */
const STATIC_PAGE_SEGMENTS = new Set([
  'activity', 'admin', 'analytics', 'assets', 'audit', 'automations', 'availability', 'awards',
  'board', 'boards', 'booking-pages', 'browse', 'calendar', 'campaigns', 'channels', 'clients',
  'companies', 'contacts', 'contracts', 'dashboard', 'dashboards', 'deadlines', 'deals',
  'deliverables', 'diagrams', 'documents', 'edit', 'engagements', 'events', 'executions',
  'expenses', 'explorer', 'folders', 'forms', 'from-time', 'goals', 'graph', 'home', 'inbox',
  'invoices', 'library', 'list', 'matrix', 'metrics', 'mismatches', 'month', 'my-work', 'new',
  'obligations', 'offers', 'overview', 'people', 'periods', 'pipeline', 'portfolio', 'preview',
  'profiles', 'projects', 'queue', 'rates', 'recent', 'renewals', 'reports', 'requests',
  'responses', 'review', 'rules', 'search', 'segments', 'settings', 'shared', 'sprints',
  'starred', 'tasks', 'templates', 'tickets', 'timeline', 'trash', 'vendors', 'views',
  'watches', 'week',
]);

export type SuiteUrlEntity =
  | { kind: 'entity'; app: string; type: VisibilityEntityType; id: string }
  | { kind: 'no_resource'; app: string }
  | { kind: 'unsupported'; app: string | null; reason: 'unsupported_app' | 'unsupported_resource' };

/** Classify a suite URL (absolute or path) for the can-read preflight. Pure. */
export function suiteUrlEntity(targetUrl: string): SuiteUrlEntity {
  const app = launchpadAppFromUrl(targetUrl);
  if (!app) return { kind: 'unsupported', app: null, reason: 'unsupported_app' };
  let pathname: string;
  try {
    pathname = new URL(targetUrl, 'http://placeholder').pathname;
  } catch {
    return { kind: 'unsupported', app, reason: 'unsupported_resource' };
  }
  // Drop the /<app> prefix (Bam is served under /b3).
  const rest = pathname.replace(/^\/[^/]+/, '') || '/';
  for (const rule of ENTITY_RULES[app] ?? []) {
    const m = rest.match(rule.re);
    if (m && m[1] && UUID_RE.test(m[1])) return { kind: 'entity', app, type: rule.type, id: m[1] };
  }
  const segments = rest.split('/').filter(Boolean);
  if (segments.every((s) => STATIC_PAGE_SEGMENTS.has(s.toLowerCase()))) return { kind: 'no_resource', app };
  return { kind: 'unsupported', app, reason: 'unsupported_resource' };
}
