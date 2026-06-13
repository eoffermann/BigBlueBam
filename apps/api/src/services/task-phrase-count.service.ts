// ---------------------------------------------------------------------------
// task phrase-count service (AGENTIC_TODO §4 Wave 5)
//
// Time-bucketed count of tasks whose (title, description_plain) tsvector
// matches a phrase, grouped by hour/day/week. Backs
// GET /v1/tasks/analytics/count-by-phrase and the `bam_task_count_by_phrase`
// MCP tool.
//
// Live query (no materialized view). Uses the existing functional GIN index
// `idx_tasks_fulltext` on to_tsvector('english', coalesce(description_plain, ''))
// plus a synthesized tsvector over title+description_plain so titles also
// match. The index covers the description_plain arm; title matches fall back
// to a scan but are cheap thanks to the caller's org_id + project scoping.
//
// Scoping:
//   - Caller's active_org_id is ALWAYS applied. Cross-org counts leak nothing.
//   - Optional project_ids[] filter narrows further; every id is verified to
//     live in the caller's org before being used in the IN clause.
//   - Optional label_ids[] filter applies `tasks.labels && $labels` (gin op).
//
// Safety:
//   - `since` is REQUIRED upstream; defend in depth here by refusing invalid.
//   - SET LOCAL statement_timeout = '5s' bounds latency.
//   - plainto_tsquery('english', phrase) neutralizes tsquery operators.
// ---------------------------------------------------------------------------

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

export type BucketGranularity = 'hour' | 'day' | 'week';

export interface TaskPhraseCountOptions {
  phrase: string;
  buckets: BucketGranularity;
  since: Date;
  until?: Date;
  /** Caller's active org. Always required to prevent cross-org leaks. */
  orgId: string;
  /** Optional project-id allowlist. Every id must be in the caller's org. */
  projectIds?: string[];
  /** Optional label-id filter: tasks with ANY of these labels match. */
  labelIds?: string[];
}

export interface TaskPhraseCountBucket {
  bucket_start: string;
  count: number;
}

export interface TaskPhraseCountResult {
  phrase: string;
  bucket_granularity: BucketGranularity;
  window: { since: string; until: string };
  buckets: TaskPhraseCountBucket[];
  total: number;
  approximate: false;
  generated_at: string;
}

export class TaskPhraseCountError extends Error {
  code: string;
  statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.name = 'TaskPhraseCountError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function normalizeBucket(bucket: BucketGranularity): string {
  switch (bucket) {
    case 'hour':
    case 'day':
    case 'week':
      return bucket;
    default:
      throw new TaskPhraseCountError('INVALID_BUCKET', 'Invalid bucket granularity');
  }
}

/**
 * Count tasks whose title+description_plain matches `phrase` per bucket.
 * Returns buckets sorted ascending by start.
 */
export async function countTasksByPhrase(
  opts: TaskPhraseCountOptions,
): Promise<TaskPhraseCountResult> {
  if (!opts.phrase || opts.phrase.trim().length === 0) {
    throw new TaskPhraseCountError('INVALID_PHRASE', 'Phrase must be non-empty');
  }
  if (!opts.orgId) {
    throw new TaskPhraseCountError('ORG_REQUIRED', 'orgId is required');
  }
  if (!(opts.since instanceof Date) || Number.isNaN(opts.since.getTime())) {
    throw new TaskPhraseCountError('INVALID_SINCE', 'window.since must be a valid date');
  }
  const bucket = normalizeBucket(opts.buckets);
  const until = opts.until ?? new Date();
  if (!(until instanceof Date) || Number.isNaN(until.getTime())) {
    throw new TaskPhraseCountError('INVALID_UNTIL', 'window.until must be a valid date');
  }
  if (until.getTime() <= opts.since.getTime()) {
    throw new TaskPhraseCountError(
      'INVALID_WINDOW',
      'window.until must be strictly greater than window.since',
    );
  }

  const tsQuery = sql`plainto_tsquery('english', ${opts.phrase})`;
  const matchExpr = sql`
    (
      to_tsvector('english', coalesce(tasks.description_plain, '')) @@ ${tsQuery}
      OR to_tsvector('english', coalesce(tasks.title, '')) @@ ${tsQuery}
    )
  `;
  const bucketExpr = sql`date_trunc(${sql.raw(`'${bucket}'`)}, tasks.created_at)`;

  // Project scoping: always join on projects for org membership; additional
  // project-id allowlist optional.
  const projectIdFilter = opts.projectIds && opts.projectIds.length > 0
    ? sql`AND tasks.project_id = ANY(${opts.projectIds}::uuid[])`
    : sql``;

  const labelFilter = opts.labelIds && opts.labelIds.length > 0
    ? sql`AND tasks.labels && ${opts.labelIds}::uuid[]`
    : sql``;

  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
    return (await tx.execute(sql`
      SELECT ${bucketExpr} AS bucket_start,
             COUNT(*)::int AS count
        FROM tasks
        JOIN projects ON projects.id = tasks.project_id
       WHERE projects.org_id = ${opts.orgId}::uuid
         AND ${matchExpr}
         AND tasks.created_at >= ${opts.since}
         AND tasks.created_at < ${until}
         ${projectIdFilter}
         ${labelFilter}
       GROUP BY bucket_start
       ORDER BY bucket_start ASC
    `)) as unknown as Array<{ bucket_start: Date | string; count: number | string }>;
  });

  const buckets: TaskPhraseCountBucket[] = (rows ?? []).map((r) => {
    const ts = r.bucket_start instanceof Date
      ? r.bucket_start.toISOString()
      : new Date(String(r.bucket_start)).toISOString();
    const c = typeof r.count === 'number' ? r.count : Number.parseInt(String(r.count), 10);
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

export const __test__ = {
  normalizeBucket,
};
