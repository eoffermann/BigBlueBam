// ---------------------------------------------------------------------------
// Expertise-for-topic route (AGENTIC_TODO §8 Wave 5)
//
// POST /v1/expertise/for-topic
//   body: {
//     topic_query: string,
//     asker_user_id?: string  // defaults to caller.id
//     signal_weights?: { beacon?, bam_activity?, brief?, bond? }
//     limit?: number
//     time_decay_half_life_days?: number
//   }
//   -> 200 { data: { topic, experts[] } }
//
// asker_user_id MUST resolve to a user in the caller's active_org_id;
// otherwise 404 (cross-org existence probing is rejected identically to
// activity-unified.routes.ts::by-actor).
//
// The `signal_weights.bam_activity` wire name matches the §8 schema in
// AGENTIC_TODO. Internally the service uses `bam`; we bridge at the route.
// ---------------------------------------------------------------------------

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/users.js';
import { requireAuth, requireScope, type AuthUser } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import { expertiseForTopic, ExpertiseError } from '../services/expertise.service.js';

const bodySchema = z.object({
  topic_query: z.string().min(1).max(500),
  asker_user_id: z.string().uuid().optional(),
  signal_weights: z
    .object({
      beacon: z.number().nonnegative().optional(),
      bam_activity: z.number().nonnegative().optional(),
      brief: z.number().nonnegative().optional(),
      bond: z.number().nonnegative().optional(),
    })
    .optional(),
  limit: z.number().int().positive().max(50).optional(),
  time_decay_half_life_days: z.number().positive().max(3650).optional(),
});

export default async function expertiseRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/v1/expertise/for-topic',
    {
      preHandler: [requireAuth, requireScope('read'), shadowOnly('bam.expertise_for_topic.create')],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = bodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid expertise query',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }
      const body = parsed.data;
      const caller = request.user as AuthUser;
      const askerId = body.asker_user_id ?? caller.id;

      // If the caller supplied a different asker, verify it's in the same
      // active org. 404 on mismatch to avoid leaking existence.
      if (askerId !== caller.id) {
        const target = await db
          .select({ org_id: users.org_id })
          .from(users)
          .where(eq(users.id, askerId))
          .limit(1);
        if (target.length === 0 || target[0]!.org_id !== caller.active_org_id) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Asker not found',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      try {
        const result = await expertiseForTopic({
          topic_query: body.topic_query,
          asker_user_id: askerId,
          org_id: caller.active_org_id,
          signal_weights: body.signal_weights
            ? {
                beacon: body.signal_weights.beacon,
                bam: body.signal_weights.bam_activity,
                brief: body.signal_weights.brief,
                bond: body.signal_weights.bond,
              }
            : undefined,
          limit: body.limit,
          time_decay_half_life_days: body.time_decay_half_life_days,
        });
        return reply.send({ data: result });
      } catch (err) {
        if (err instanceof ExpertiseError) {
          return reply.status(err.statusCode).send({
            error: {
              code: err.code,
              message: err.message,
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
