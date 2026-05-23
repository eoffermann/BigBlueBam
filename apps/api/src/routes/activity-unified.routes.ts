import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/users.js';
import { requireAuth, type AuthUser } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as activityUnified from '../services/activity-unified.service.js';

/**
 * Unified activity-log routes (AGENTIC_TODO §5, Wave 3).
 *
 * Surface:
 *   GET /v1/activity/unified            by (entity_type, entity_id)
 *   GET /v1/activity/unified/by-actor   by actor_id (must share caller's active org)
 *
 * Both require an authenticated caller. Visibility gating is applied at the
 * SQL level by the service layer; see activity-unified.service.ts for the
 * cross-app WHERE predicate.
 *
 * Cursor format: `<ISO-8601 created_at>|<row uuid>` so pagination is
 * strictly ordered even across UNION ALL rows that share a created_at.
 */

const unifiedQuerySchema = z.object({
  entity_type: z.string().min(1).max(100),
  entity_id: z.string().uuid(),
  since: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

const byActorQuerySchema = z.object({
  actor_id: z.string().uuid(),
  since: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});

function parseSince(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export default async function activityUnifiedRoutes(fastify: FastifyInstance) {
  // ────────────────────────────────────────────────────────────────────
  // GET /v1/activity/unified?entity_type=&entity_id=&since=&cursor=&limit=
  // ────────────────────────────────────────────────────────────────────
  fastify.get(
    '/v1/activity/unified',
    { preHandler: [requireAuth, shadowOnly('bam.activity_unified.list')] },
    async (request, reply) => {
      const user = request.user as AuthUser;
      const parsed = unifiedQuerySchema.safeParse(request.query);
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

      const result = await activityUnified.queryByEntity({
        caller: { user_id: user.id, active_org_id: user.active_org_id },
        entity_type: parsed.data.entity_type,
        entity_id: parsed.data.entity_id,
        since: parseSince(parsed.data.since),
        cursor: parsed.data.cursor,
        limit: parsed.data.limit,
      });

      return reply.send(result);
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // GET /v1/activity/unified/by-actor?actor_id=&since=&cursor=&limit=
  // ────────────────────────────────────────────────────────────────────
  //
  // Matches the agent_audit pattern: we 404 rather than 403 when the
  // target actor is not in the caller's active org so cross-org
  // existence cannot be probed via timing / response codes.
  fastify.get(
    '/v1/activity/unified/by-actor',
    { preHandler: [requireAuth, shadowOnly('bam.activity_unified_by_actor.list')] },
    async (request, reply) => {
      const user = request.user as AuthUser;
      const parsed = byActorQuerySchema.safeParse(request.query);
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

      const targetRows = await db
        .select({ org_id: users.org_id })
        .from(users)
        .where(eq(users.id, parsed.data.actor_id))
        .limit(1);

      if (targetRows.length === 0 || targetRows[0]!.org_id !== user.active_org_id) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Actor not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const result = await activityUnified.queryByActor({
        caller: { user_id: user.id, active_org_id: user.active_org_id },
        actor_id: parsed.data.actor_id,
        since: parseSince(parsed.data.since),
        cursor: parsed.data.cursor,
        limit: parsed.data.limit,
      });

      return reply.send(result);
    },
  );
}
