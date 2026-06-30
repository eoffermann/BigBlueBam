/**
 * Blip field-index creation (Blip §7.3).
 *
 * Reserved fields are always indexed. Arbitrary JSONB fields are sortable but
 * unindexed by default; promoting a hot one (`blip.field.index`) builds a btree
 * expression index on `payload->>'<field>'` and flips blip_field_catalog.is_indexed.
 *
 * Index creation is heavy and explicit, never automatic. The index is created on
 * the partitioned parent (blip_entries) WITHOUT CONCURRENTLY: Postgres does not
 * support CREATE INDEX CONCURRENTLY on a partitioned parent, but a plain
 * CREATE INDEX cascades the definition to every partition (taking a brief lock
 * per partition). That is the correct, simple primitive here.
 */

import { createHash } from 'node:crypto';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql } from 'drizzle-orm';
import type { BlipFieldIndexJobData } from '@bigbluebam/shared';
import { getDb } from '../utils/db.js';

/**
 * Build the JSONB extraction SQL fragment for a field_path. Accepts either a
 * reserved/bare name's `payload:<dot.path>` form or a raw dotted path. Only
 * `[A-Za-z0-9_.]` is allowed so the path is safe to inline.
 */
function buildExtractExpr(fieldPath: string): string {
  const raw = fieldPath.startsWith('payload:') ? fieldPath.slice('payload:'.length) : fieldPath;
  if (!/^[A-Za-z0-9_.]+$/.test(raw) || raw.length === 0) {
    throw new Error(`blip-field-index: unsafe field_path: ${fieldPath}`);
  }
  const segments = raw.split('.');
  if (segments.length === 1) {
    return `(payload->>'${segments[0]}')`;
  }
  return `(payload#>>'{${segments.join(',')}}')`;
}

export async function processBlipFieldIndexJob(
  job: Job<BlipFieldIndexJobData>,
  logger: Logger,
): Promise<void> {
  const db = getDb();
  const { org_id, tracked_app_id, report_type, field_path } = job.data;

  const extractExpr = buildExtractExpr(field_path);
  const hash = createHash('sha256')
    .update(`${tracked_app_id}:${report_type}:${field_path}`)
    .digest('hex')
    .slice(0, 16);
  const indexName = `blip_idx_${hash}`;

  logger.info({ jobId: job.id, indexName, field_path }, 'blip-field-index: creating index');

  // Plain CREATE INDEX on the partitioned parent: it cascades the definition to
  // every partition. CONCURRENTLY is not allowed on a partitioned parent.
  await db.execute(
    sql.raw(
      `CREATE INDEX IF NOT EXISTS ${indexName} ` +
        `ON blip_entries (${extractExpr})`,
    ),
  );

  await db.execute(sql`
    UPDATE blip_field_catalog
    SET is_indexed = true
    WHERE tracked_app_id = ${tracked_app_id}
      AND report_type = ${report_type}
      AND field_path = ${field_path}
      AND org_id = ${org_id}
  `);

  logger.info({ jobId: job.id, indexName }, 'blip-field-index: index ready');
}
