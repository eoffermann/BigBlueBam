/**
 * Blip "freeze to JSONL" export (Blip §14).
 *
 * `blip.entry.export` materializes a filtered (tracked_app, report_type)
 * collection as a JSONL asset — one redacted payload object per line. The design
 * intent is to create a normal Bin asset (Bin has no freeze primitive, so Blip
 * drives the creation) so the frozen archive is viewable read-only in Bin's
 * structured viewer.
 *
 * What this implementation does (best-effort, documented): it queries the
 * matching entries, encodes one redacted payload per line, and PUTs the JSONL
 * object to the shared storage backbone at
 *   <org_id>/blip/exports/<uuid>.jsonl
 * then logs the object key. Creating the actual bin_assets row through the Bin
 * internal API is left as a TODO: it requires the Bin asset-upload contract +
 * internal service auth, which is outside the worker's current wiring. The
 * object is in place for a follow-up that registers it as a Bin asset.
 *
 * The `filter` is applied minimally (session_id / level equality + an
 * elapsed_ms floor when present); a full §7.1 predicate compiler is not
 * replicated here. Unrecognized filter shapes degrade to "no extra filter".
 */

import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import { sql, type SQL } from 'drizzle-orm';
import type { BlipExportJobData } from '@bigbluebam/shared';
import { getDb } from '../utils/db.js';
import { putObjectBuffer } from '../utils/storage.js';

const MAX_ROWS = 1_000_000;
const PAGE = 5000;

interface EntryRow {
  received_at: string;
  id: string;
  payload: Record<string, unknown>;
}

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

/**
 * Best-effort translation of a flat filter object to an extra WHERE fragment.
 * Recognizes top-level reserved-column equality plus an elapsed_ms floor. Any
 * shape it doesn't understand contributes no predicate (export wider, never
 * narrower-than-intended in a way that loses the report_type scope).
 */
function buildFilterClause(filter: unknown): SQL {
  if (!filter || typeof filter !== 'object') return sql``;
  const f = filter as Record<string, unknown>;
  const parts: SQL[] = [];
  if (typeof f.session_id === 'string') parts.push(sql`AND session_id = ${f.session_id}`);
  if (typeof f.level === 'string') parts.push(sql`AND level = ${f.level}`);
  if (typeof f.platform === 'string') parts.push(sql`AND platform = ${f.platform}`);
  if (typeof f.app_version === 'string') parts.push(sql`AND app_version = ${f.app_version}`);
  if (typeof f.min_elapsed_ms === 'number') parts.push(sql`AND elapsed_ms >= ${f.min_elapsed_ms}`);
  return parts.length > 0 ? sql.join(parts, sql` `) : sql``;
}

export async function processBlipExportJsonlJob(
  job: Job<BlipExportJobData>,
  logger: Logger,
): Promise<void> {
  const db = getDb();
  const { org_id, tracked_app_id, report_type, filter, asset_name } = job.data;
  const filterClause = buildFilterClause(filter);

  const objectKey = `${org_id}/blip/exports/${randomUUID()}.jsonl`;
  const lines: string[] = [];
  let total = 0;

  // Keyset pagination over the (received_at, id) PK for a stable, bounded scan.
  let afterReceived: string | null = null;
  let afterId: string | null = null;

  for (;;) {
    const keyset: SQL =
      afterReceived && afterId
        ? sql`AND (received_at, id) > (${afterReceived}::timestamptz, ${afterId}::uuid)`
        : sql``;
    const batch: EntryRow[] = rows<EntryRow>(
      await db.execute(sql`
        SELECT received_at, id, payload
        FROM blip_entries
        WHERE org_id = ${org_id}
          AND tracked_app_id = ${tracked_app_id}
          AND report_type = ${report_type}
          ${filterClause}
          ${keyset}
        ORDER BY received_at ASC, id ASC
        LIMIT ${PAGE}
      `),
    );
    if (batch.length === 0) break;
    for (const r of batch) {
      lines.push(JSON.stringify(r.payload));
      total += 1;
    }
    const last = batch[batch.length - 1];
    if (!last) break;
    afterReceived = last.received_at;
    afterId = last.id;
    if (batch.length < PAGE || total >= MAX_ROWS) break;
  }

  const body = Buffer.from(lines.length > 0 ? lines.join('\n') + '\n' : '', 'utf8');
  await putObjectBuffer(objectKey, body, 'application/x-ndjson');

  logger.info(
    { jobId: job.id, objectKey, rows: total, assetName: asset_name },
    'blip-export-jsonl: JSONL frozen to storage (Bin asset registration is a follow-up TODO)',
  );
}
