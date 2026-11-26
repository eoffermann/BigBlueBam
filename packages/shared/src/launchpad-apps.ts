/**
 * The single list of Launchpad app ids (issue #144).
 *
 * Every place that needs the set of addressable Launchpad apps derives it from
 * this constant:
 *   - the api's Launchpad routes and stored-override validation
 *     (apps/api/src/routes/system-settings.routes.ts re-exports it as
 *     LAUNCHPAD_APP_IDS; apps/api/src/routes/launchpad.routes.ts)
 *   - the MCP platform tools' app-id enum (apps/mcp-server/src/tools/platform-tools.ts)
 *
 * The rendering metadata (name, description, icon, color, path) stays in
 * LAUNCHPAD_CATALOG in system-settings.routes.ts, which the docs and nginx
 * scripts parse; an api test asserts the catalog covers exactly these ids.
 *
 * Adding a new app: append its id here (order is display order), then add its
 * LAUNCHPAD_CATALOG row.
 */
export const LAUNCHPAD_APP_IDS = [
  'b3',
  'banter',
  'beacon',
  'bond',
  'blast',
  'bill',
  'blank',
  'book',
  'bench',
  'brief',
  'bolt',
  'bearing',
  'board',
  'blueprint',
  'bin',
  'bay',
  'blip',
  'helpdesk',
  'bureau',
  'basis',
  'braid',
  'bulwark',
  'burn',
  'bursar',
] as const;

export type LaunchpadAppId = (typeof LAUNCHPAD_APP_IDS)[number];
