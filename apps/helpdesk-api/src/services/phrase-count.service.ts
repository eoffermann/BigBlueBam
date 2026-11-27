// ---------------------------------------------------------------------------
// phrase-count service (AGENTIC_TODO §4 Wave 5)
//
// Time-bucketed count of tickets whose (subject, description) tsvector matches
// a phrase, grouped by hour/day/week. Backs GET /v1/tickets/analytics/count-by-phrase
// and the `helpdesk_ticket_count_by_phrase` MCP tool.
//
// Live query (no materialized view). Uses the existing generated
// `tickets.search_vector` column + GIN index (migration 0112) so the
// @@ predicate is sargable. date_trunc(bucket, created_at) is the
// GROUP BY key. Bucket boundaries are whatever Postgres emits for the
// requested truncation granularity in the DB's timezone.
//
// Safety:
//   - `window.since` is REQUIRED upstream; this service defends in depth by
//     refusing an open-ended range if the caller forgets to supply it.
//   - A server-side `SET LOCAL statement_timeout = '5s'` bounds latency so
//     a pathological phrase cannot wedge a connection.
//   - `plainto_tsquery('english', phrase)` neutralizes tsquery operators in
//     user input. Phrase is further length-bounded at the route.
// ---------------------------------------------------------------------------

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

export type BucketGranularity = 'hour' | 'day' | 'week';

export interface PhraseCountOptions {
  /** Required: the count is confined to this org's tickets. Without it the
   *  query counted every tenant's tickets, an oracle for another org's
   *  support volume on any phrase. */
  orgId: string;
  phrase: string;
  buckets: BucketGranularity;
  since: Date;
  until?: Date;
  statusFilter?: string;
}

export interface PhraseCountBucket {
  bucket_start: string;
  count: number;
}

export interface PhraseCountResult {
  phrase: string;
  bucket_granularity: BucketGranularity;
  window: { since: string; until: string };
  buckets: PhraseCountBucket[];
  total: number;
  approximate: false;
  generated_at: string;
}

export class PhraseCountError extends Error {
  code: string;
  statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'PhraseCountError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeBucket(bucket: BucketGranularity): string {
  // Postgres-safe bucket label. We validate with an allowlist at the route
  // level and here to double-gate against injection; the `bucket` value is
  // interpolated as an SQL literal inside date_trunc().
  switch (bucket) {
    case 'hour':
    case 'day':
    case 'week':
      return bucket;
    default:
      throw new PhraseCountError('INVALID_BUCKET', 'Invalid bucket granularity');
  }
}

/**
 * Count tickets matching `phrase` (subject+description tsvector) per
 * bucket in [since, until]. Returns sorted buckets ascending by start.
 */
export async function countTicketsByPhrase(
  opts: PhraseCountOptions,
): Promise<PhraseCountResult> {
  if (!opts.orgId) {
    throw new PhraseCountError('INVALID_ORG', 'orgId is required');
  }
  if (!opts.phrase || opts.phrase.trim().length === 0) {
    throw new PhraseCountError('INVALID_PHRASE', 'Phrase must be non-empty');
  }
  if (!(opts.since instanceof Date) || Number.isNaN(opts.since.getTime())) {
    throw new PhraseCountError('INVALID_SINCE', 'window.since must be a valid date');
  }

  const bucket = normalizeBucket(opts.buckets);
  const until = opts.until ?? new Date();
  if (!(until instanceof Date) || Number.isNaN(until.getTime())) {
    throw new PhraseCountError('INVALID_UNTIL', 'window.until must be a valid date');
  }
  if (until.getTime() <= opts.since.getTime()) {
    throw new PhraseCountError(
      'INVALID_WINDOW',
      'window.until must be strictly greater than window.since',
    );
  }

  const tsQuery = sql`plainto_tsquery('english', ${opts.phrase})`;
  // date_trunc's first argument MUST be a plain literal; we inject the
  // bucket token via sql.raw after normalizeBucket has allowlisted it.
  const bucketExpr = sql`date_trunc(${sql.raw(`'${bucket}'`)}, tickets.created_at)`;

  const statusClause = opts.statusFilter
    ? sql`AND tickets.status = ${opts.statusFilter}`
    : sql``;

  // Set statement timeout inside a transaction so it applies only to this
  // query, not the pooled connection for later callers. Use SET LOCAL which
  // resets at COMMIT/ROLLBACK.
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    return (await tx.execute(sql`
      SELECT ${bucketExpr} AS bucket_start,
             COUNT(*)::int AS count
        FROM tickets
        -- Org via the ticket's helpdesk user, not projects.org_id:
        -- tickets.project_id is nullable and a projects join would drop
        -- every unassigned ticket from the count.
        JOIN helpdesk_users hu ON hu.id = tickets.helpdesk_user_id
       WHERE hu.org_id = ${opts.orgId}
         AND tickets.search_vector @@ ${tsQuery}
         AND tickets.created_at >= ${opts.since}
         AND tickets.created_at < ${until}
         ${statusClause}
       GROUP BY bucket_start
       ORDER BY bucket_start ASC
    `)) as unknown as Array<{ bucket_start: Date | string; count: number | string }>;
  });

  const buckets: PhraseCountBucket[] = (rows ?? []).map((r) => {
    const ts = r.bucket_start instanceof Date
      ? r.bucket_start.toISOString()
      : new Date(String(r.bucket_start)).toISOString();
    const c = typeof r.count === 'number' ? r.count : parseInt(String(r.count), 10);
    return { bucket_start: ts, count: c };
  });
  const total = buckets.reduce((acc, b) => acc + b.count, 0);

  return {
    phrase: opts.phrase,
    bucket_granularity: opts.buckets,
    window: { since: opts.since.toISOString(), until: until.toISOString() },
    buckets,
    total,
    approximate: false,
    generated_at: new Date().toISOString(),
  };
}

// Exports for unit tests: let tests exercise the bucket allowlist and the
// input-validation paths without touching the db mock.
export const __test__ = {
  normalizeBucket,
};
