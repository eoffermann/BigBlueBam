/**
 * Per-org task priority defaults.
 *
 * Matches the seed set in migration 0183_priorities.sql exactly so that
 * orgs created at runtime get the same starting set as orgs that were
 * backfilled by the migration. Keep these in sync — if the catalog ever
 * changes, update both the SQL backfill in 0183 (for existing orgs at
 * upgrade time) AND this constant (for orgs minted after).
 */
import { sql } from 'drizzle-orm';
import type { db as defaultDb } from '../db/index.js';

export const DEFAULT_PRIORITIES = [
  { value: 'critical', name: 'Critical', color: '#dc2626', icon: 'alert-triangle', position: 0, is_default: false },
  { value: 'high',     name: 'High',     color: '#f97316', icon: 'arrow-up',       position: 1, is_default: false },
  { value: 'medium',   name: 'Medium',   color: '#eab308', icon: 'minus',          position: 2, is_default: true  },
  { value: 'low',      name: 'Low',      color: '#60a5fa', icon: 'arrow-down',     position: 3, is_default: false },
  { value: 'none',     name: 'None',     color: '#a1a1aa', icon: null,             position: 4, is_default: false },
] as const;

/**
 * Idempotently seed the org-level priority catalog. Safe to call from
 * an org-creation transaction; ON CONFLICT keeps it a no-op when the
 * rows are already present (e.g. via the 0183 backfill). The tx
 * argument is intentionally typed loosely (a drizzle tx or the global
 * db) so this stays callable from any of the registration code paths
 * without coupling to a specific driver type. We only use `.execute`,
 * which both code-paths share.
 */
type Executor = Pick<typeof defaultDb, 'execute'>;

export async function seedDefaultPriorities(
  tx: Executor,
  orgId: string,
): Promise<void> {
  // Raw SQL with VALUES so we can do this in a single round-trip
  // without depending on the drizzle table import here (this service
  // is intentionally lightweight and is meant to be importable from
  // anywhere an org gets minted).
  await tx.execute(sql`
    INSERT INTO priorities (org_id, value, name, color, icon, position, is_default)
    VALUES
      (${orgId}, 'critical', 'Critical', '#dc2626', 'alert-triangle', 0, false),
      (${orgId}, 'high',     'High',     '#f97316', 'arrow-up',       1, false),
      (${orgId}, 'medium',   'Medium',   '#eab308', 'minus',          2, true),
      (${orgId}, 'low',      'Low',      '#60a5fa', 'arrow-down',     3, false),
      (${orgId}, 'none',     'None',     '#a1a1aa', NULL,             4, false)
    ON CONFLICT (org_id, value) DO NOTHING
  `);
}
