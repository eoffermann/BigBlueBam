/**
 * The single list of Bolt event sources (issue #124).
 *
 * Every place that needs the set of valid Bolt `source` values derives it from
 * this constant:
 *   - bolt-api ingest validation (apps/bolt-api/src/routes/event-ingestion.routes.ts)
 *   - bolt-api automation trigger validation (TRIGGER_SOURCES in automation.routes.ts)
 *   - the Drizzle pgEnum `bolt_trigger_source` (apps/bolt-api/src/db/schema/bolt-automations.ts)
 *   - the stored-data type `TriggerSourceV1` (bolt-automation-versions/v1.ts)
 *
 * The Postgres enum `bolt_trigger_source` cannot be derived at runtime, so it is
 * CHECKED instead: `scripts/check-bolt-enum.mjs` (run in the db-drift CI job)
 * compares `enum_range(NULL::bolt_trigger_source)` against this list, and
 * `scripts/check-bolt-catalog.mjs` fails when a catalog or call-site source is
 * missing here.
 *
 * Adding a new app that publishes Bolt events:
 *   1. append its source name below;
 *   2. add a migration with `ALTER TYPE bolt_trigger_source ADD VALUE IF NOT EXISTS '<name>';`
 *      (do not use the new value in the same file);
 *   3. run `node scripts/check-bolt-catalog.mjs`.
 *
 * Order matters only for display; append new values at the end.
 */
export const BOLT_SOURCES = [
  'bam',
  'banter',
  'beacon',
  'brief',
  'helpdesk',
  'schedule',
  'bond',
  'blast',
  'board',
  'bench',
  'bearing',
  'bill',
  'book',
  'blank',
  'platform',
  'burn',
  'bulwark',
  'braid',
  'basis',
  'blip',
  'blueprint',
  'bureau',
  'bin',
  'bay',
  'bursar',
  'bastion',
] as const;

export type BoltSource = (typeof BOLT_SOURCES)[number];

const BOLT_SOURCE_SET: ReadonlySet<string> = new Set(BOLT_SOURCES);

export function isBoltSource(value: unknown): value is BoltSource {
  return typeof value === 'string' && BOLT_SOURCE_SET.has(value);
}
