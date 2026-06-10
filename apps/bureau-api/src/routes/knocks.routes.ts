/**
 * Bureau knock routes (workstream 2 — Agent B).
 *
 *   POST  /v1/knocks         — create a pending knock against an office
 *   PATCH /v1/knocks/:id     — owner resolves: admit / defer / decline
 *   GET   /v1/knocks/inbox   — pending knocks where caller is the owner
 *
 * Door semantics: only `type='office'` rooms can be knocked. The
 * visitor cannot knock on their own office (no row inserted, 400
 * BAD_REQUEST). When the room has no owner_id set, the knock is
 * still recorded against the room but with owner_id resolved to null;
 * the resolve flow then guards against orphan knocks by 404'ing on
 * mismatched owner. This matches the design doc's audit-first stance
 * (every attempt is logged) without surfacing "knock landed in a
 * void" failures back to the visitor.
 *
 * The Bolt event firehose for `bureau.knock.created` /
 * `bureau.knock.resolved` is a follow-up workstream; we set the row
 * up so a future publisher can emit cleanly.
 */

import type { FastifyInstance } from 'fastify';
import { and, eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { bureauKnocks } from '../db/schema/bureau.js';
import { requireAuth } from '../plugins/auth.js';
import {
  badRequest,
  forbidden,
  loadRoom,
  notFound,
  roomNotFound,
} from '../middleware/room-access.js';

const createBody = z.object({
  room_id: z.string().uuid(),
  message: z.string().max(1000).optional(),
});

const patchBody = z.object({
  decision: z.enum(['admit', 'defer', 'decline']),
});

const DECISION_TO_STATUS = {
  admit: 'admitted',
  defer: 'deferred',
  decline: 'declined',
} as const;

export default async function knocksRoutes(fastify: FastifyInstance) {
  // POST /v1/knocks — visitor knocks on an office door
  fastify.post(
    '/knocks',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;

      const parsed = createBody.safeParse(request.body);
      if (!parsed.success) {
        return badRequest(
          request,
          reply,
          'Invalid request body',
          parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            issue: i.message,
          })),
        );
      }
      const { room_id, message } = parsed.data;

      const room = await loadRoom(room_id, user.org_id);
      if (!room) return roomNotFound(request, reply);

      if (room.type !== 'office') {
        return badRequest(
          request,
          reply,
          'Only office rooms can be knocked on',
        );
      }
      if (room.owner_id && room.owner_id === user.id) {
        return badRequest(request, reply, 'You cannot knock on your own office');
      }
      if (!room.owner_id) {
        // Unassigned office — nobody to admit/decline. Surface a friendly
        // 400 instead of writing an orphan row.
        return badRequest(
          request,
          reply,
          'This office has no occupant to receive a knock',
        );
      }

      const [created] = await db
        .insert(bureauKnocks)
        .values({
          org_id: user.org_id,
          room_id: room.id,
          visitor_id: user.id,
          owner_id: room.owner_id,
          status: 'pending',
          message: message ?? null,
        })
        .returning({
          id: bureauKnocks.id,
          org_id: bureauKnocks.org_id,
          room_id: bureauKnocks.room_id,
          visitor_id: bureauKnocks.visitor_id,
          owner_id: bureauKnocks.owner_id,
          status: bureauKnocks.status,
          message: bureauKnocks.message,
          created_at: bureauKnocks.created_at,
          resolved_at: bureauKnocks.resolved_at,
        });

      return reply.status(201).send({ data: created });
    },
  );

  // PATCH /v1/knocks/:id — owner resolves the knock
  fastify.patch(
    '/knocks/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id: knockId } = request.params as { id: string };
      const user = request.user!;

      const parsed = patchBody.safeParse(request.body);
      if (!parsed.success) {
        return badRequest(
          request,
          reply,
          'Invalid request body',
          parsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            issue: i.message,
          })),
        );
      }

      const [existing] = await db
        .select({
          id: bureauKnocks.id,
          owner_id: bureauKnocks.owner_id,
          status: bureauKnocks.status,
        })
        .from(bureauKnocks)
        .where(
          and(eq(bureauKnocks.id, knockId), eq(bureauKnocks.org_id, user.org_id)),
        )
        .limit(1);

      if (!existing) return notFound(request, reply, 'Knock not found');
      if (existing.owner_id !== user.id) {
        return forbidden(
          request,
          reply,
          'Only the room owner can resolve this knock',
        );
      }
      if (existing.status !== 'pending') {
        return badRequest(
          request,
          reply,
          `Knock is already resolved (status=${existing.status})`,
        );
      }

      const nextStatus = DECISION_TO_STATUS[parsed.data.decision];
      const [updated] = await db
        .update(bureauKnocks)
        .set({ status: nextStatus, resolved_at: new Date() })
        .where(
          and(eq(bureauKnocks.id, knockId), eq(bureauKnocks.org_id, user.org_id)),
        )
        .returning({
          id: bureauKnocks.id,
          org_id: bureauKnocks.org_id,
          room_id: bureauKnocks.room_id,
          visitor_id: bureauKnocks.visitor_id,
          owner_id: bureauKnocks.owner_id,
          status: bureauKnocks.status,
          message: bureauKnocks.message,
          created_at: bureauKnocks.created_at,
          resolved_at: bureauKnocks.resolved_at,
        });

      return reply.status(200).send({ data: updated });
    },
  );

  // GET /v1/knocks/inbox — pending knocks where caller is the owner
  fastify.get(
    '/knocks/inbox',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;

      const rows = await db
        .select({
          id: bureauKnocks.id,
          org_id: bureauKnocks.org_id,
          room_id: bureauKnocks.room_id,
          visitor_id: bureauKnocks.visitor_id,
          owner_id: bureauKnocks.owner_id,
          status: bureauKnocks.status,
          message: bureauKnocks.message,
          created_at: bureauKnocks.created_at,
          resolved_at: bureauKnocks.resolved_at,
        })
        .from(bureauKnocks)
        .where(
          and(
            eq(bureauKnocks.org_id, user.org_id),
            eq(bureauKnocks.owner_id, user.id),
            eq(bureauKnocks.status, 'pending'),
          ),
        )
        .orderBy(desc(bureauKnocks.created_at));

      return reply.status(200).send({ data: rows });
    },
  );
}
