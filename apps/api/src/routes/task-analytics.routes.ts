// ---------------------------------------------------------------------------
// Bam task analytics routes (AGENTIC_TODO §4 Wave 5)
//
// Trend / count-by-phrase queries over tasks. Any authenticated caller with
// read scope. Every row is scoped to the caller's active_org_id before the
// tsvector match runs, and optional project_ids filter is validated against
// that org so an out-of-org id cannot be smuggled in.
//
// Routes:
//   GET /v1/tasks/analytics/count-by-phrase
//     query: phrase, buckets=hour|day|week, since (ISO), until? (ISO),
//            labels? (comma-separated UUIDs), projects? (comma-separated UUIDs)
//     -> 200 { phrase, bucket_granularity, window, buckets[], total,
//               approximate:false, generated_at }
// ---------------------------------------------------------------------------

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { projects } from '../db/schema/projects.js';
import { requireAuth, requireScope, type AuthUser } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import {
  countTasksByPhrase,
  TaskPhraseCountError,
} from '../services/task-phrase-count.service.js';

const bucketEnum = z.enum(['hour', 'day', 'week']);

const uuidList = z
  .string()
  .optional()
  .transform((v) => {
    if (!v) return [] as string[];
    return v
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  })
  .pipe(z.array(z.string().uuid()).max(100));

const querySchema = z.object({
  phrase: z.string().min(1).max(500),
  buckets: bucketEnum,
  since: z.string().datetime({ offset: true }).or(z.string().datetime()),
  until: z
    .string()
    .datetime({ offset: true })
    .or(z.string().datetime())
    .optional(),
  labels: uuidList.optional(),
  projects: uuidList.optional(),
});

export default async function taskAnalyticsRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/v1/tasks/analytics/count-by-phrase',
    {
      preHandler: [requireAuth, requireScope('read'), shadowOnly('bam.task_analytic_count_by_phrase.list')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = querySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid query parameters',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }
      const q = parsed.data;
      const user = request.user as AuthUser;
      const since = new Date(q.since);
      const until = q.until ? new Date(q.until) : new Date();

      // Validate project_ids are in the caller's org before we pass them
      // to the service. Empty array -> no filter.
      let projectIds: string[] | undefined;
      if (q.projects && q.projects.length > 0) {
        const rows = await db
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.org_id, user.active_org_id),
              inArray(projects.id, q.projects),
            ),
          );
        projectIds = rows.map((r) => r.id);
        if (projectIds.length === 0) {
          // No in-org matches, short-circuit to empty result so we do not
          // hit the DB with an impossible clause.
          return reply.send({
            phrase: q.phrase,
            bucket_granularity: q.buckets,
            window: { since: since.toISOString(), until: until.toISOString() },
            buckets: [],
            total: 0,
            approximate: false,
            generated_at: new Date().toISOString(),
          });
        }
      }

      try {
        const result = await countTasksByPhrase({
          phrase: q.phrase,
          buckets: q.buckets,
          since,
          until,
          orgId: user.active_org_id,
          projectIds,
          labelIds: q.labels && q.labels.length > 0 ? q.labels : undefined,
        });
        return reply.send(result);
      } catch (err) {
        if (err instanceof TaskPhraseCountError) {
          return reply.status(err.statusCode).send({
            error: {
              code: err.code,
              message: err.message,
              details: [],
              request_id: request.id,
            },
          });
        }
        const msg = err instanceof Error ? err.message : String(err);
        if (/statement.*timeout/i.test(msg)) {
          return reply.status(504).send({
            error: {
              code: 'PHRASE_COUNT_TIMEOUT',
              message: 'Query exceeded 5s budget',
              details: [],
              request_id: request.id,
            },
          });
        }
        throw err;
      }
    },
  );
}
