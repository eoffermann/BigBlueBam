/**
 * Bureau knock routes (workstreams 2 + 5 — Agent B).
 *
 *   POST  /v1/knocks               — create a pending knock against an office
 *   PATCH /v1/knocks/:id           — owner resolves: admit / defer / decline
 *   GET   /v1/knocks/inbox         — pending knocks where caller is the owner
 *   POST  /v1/knocks/leave-note    — send a DM to the owner when DND blocked
 *
 * Door semantics: only `type='office'` rooms can be knocked. The
 * visitor cannot knock on their own office (no row inserted, 400
 * BAD_REQUEST). When the room has no owner_id set the visitor sees a
 * friendly 400 — no row is written because there is nobody to admit it.
 *
 * Workstream 5 additions (§4.3):
 *   1. If the OWNER is currently in DND (any of their live Bureau sessions
 *      reports status='dnd'), the knock is rejected with 423 Locked and
 *      the response advertises the "leave a note" follow-up endpoint.
 *      No row is persisted and no `knock.requested` Bolt event fires.
 *   2. On successful create, a BullMQ delayed job is scheduled to flip the
 *      knock to `timed_out` after 30 seconds if the owner hasn't responded.
 *      See apps/worker/src/jobs/bureau-knock-timeout.ts for the consumer.
 *   3. POST /v1/knocks/leave-note posts a DM to the owner via banter-api's
 *      internal endpoint, prefixed with '[Bureau knock note] '. If banter-
 *      api is unreachable we log + return 202 so the visitor isn't stuck.
 */

import type { FastifyInstance } from 'fastify';
import { and, eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { bureauKnocks } from '../db/schema/bureau.js';
import { env } from '../env.js';
import { requireAuth } from '../plugins/auth.js';
import {
  badRequest,
  forbidden,
  loadRoom,
  notFound,
  roomNotFound,
} from '../middleware/room-access.js';
import { isUserInDnd } from '../services/dnd-check.service.js';
import { scheduleKnockTimeout } from '../services/knock-queue.service.js';
import { emitKnockRequested } from '../lib/bureau-events.js';

const createBody = z.object({
  room_id: z.string().uuid(),
  message: z.string().max(1000).optional(),
});

const patchBody = z.object({
  decision: z.enum(['admit', 'defer', 'decline']),
});

const leaveNoteBody = z.object({
  room_id: z.string().uuid(),
  message: z.string().min(1).max(2000),
});

const DECISION_TO_STATUS = {
  admit: 'admitted',
  defer: 'deferred',
  decline: 'declined',
} as const;

const KNOCK_NOTE_PREFIX = '[Bureau knock note] ';

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

      // §4.3 DND check — owner's live sessions decide whether the knock is
      // accepted at all. If any live session reports DND, fail fast with
      // 423 Locked and point the caller at the leave-a-note follow-up.
      const ownerInDnd = await isUserInDnd(fastify.redis, room.owner_id);
      if (ownerInDnd) {
        return reply.status(423).send({
          error: {
            code: 'OWNER_DND',
            message: 'The owner of this office is currently in Do Not Disturb',
            details: [],
            request_id: request.id,
            dnd_owner: true,
            leave_a_note_endpoint: `/v1/knocks/${room.id}/leave-note`,
          },
        });
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

      if (!created) {
        // Insert returned no row — shouldn't happen with .returning() on
        // postgres-js but bail safely if it does.
        return reply.status(500).send({
          error: {
            code: 'INTERNAL',
            message: 'Failed to create knock',
            details: [],
            request_id: request.id,
          },
        });
      }

      // §4.3 schedule the 30s timeout. Fire-and-forget — a queue hiccup
      // should not block the knock from being created.
      void scheduleKnockTimeout(created.id);

      // §14 Bolt event — knock.requested. Fire-and-forget.
      emitKnockRequested(user.org_id, user.id, {
        knock: { id: created.id },
        room: { id: room.id, name: null },
        visitor: { id: user.id, name: user.display_name },
        owner: { id: room.owner_id },
        message: created.message,
        actor: { id: user.id },
        org: { id: user.org_id },
      }).catch(() => {
        /* fire-and-forget */
      });

      return reply.status(201).send({ data: created });
    },
  );

  // POST /v1/knocks/leave-note — DND fallback: send a Banter DM to the owner
  fastify.post(
    '/knocks/leave-note',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;

      const parsed = leaveNoteBody.safeParse(request.body);
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
          'Only office rooms accept a leave-a-note follow-up',
        );
      }
      if (!room.owner_id) {
        return badRequest(
          request,
          reply,
          'This office has no occupant to receive a note',
        );
      }
      if (room.owner_id === user.id) {
        return badRequest(request, reply, 'You cannot leave a note on your own office');
      }

      const prefixedMessage = `${KNOCK_NOTE_PREFIX}${message}`;

      // Deliver via banter-api's POST /v1/internal/dm (D-11): finds or
      // creates the 1:1 DM channel, posts the note as the visitor, and
      // notifies the owner. On any transport failure we still fall back to
      // a logged 202 so the visitor isn't stuck waiting on Banter.
      const internalSecret = env.INTERNAL_SERVICE_SECRET;
      // Banter API internal base — bureau-api does not yet have a dedicated
      // env var for it, so derive from the docker-compose service name and
      // allow override via BANTER_INTERNAL_URL.
      const banterInternalUrl = process.env.BANTER_INTERNAL_URL ?? 'http://banter-api:4002';

      let delivered = false;
      if (internalSecret) {
        try {
          const res = await fetch(`${banterInternalUrl}/v1/internal/dm`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Secret': internalSecret,
              'X-Internal-Service-Secret': internalSecret,
            },
            body: JSON.stringify({
              org_id: user.org_id,
              from_user_id: user.id,
              to_user_id: room.owner_id,
              content: prefixedMessage,
              source: 'bureau-knock-note',
            }),
            // Short timeout — the visitor is waiting on the response.
            signal: AbortSignal.timeout(3_000),
          });
          if (res.ok) {
            delivered = true;
          } else {
            request.log.warn(
              { status: res.status, banterInternalUrl },
              'Bureau leave-note: banter internal DM returned non-OK; falling back to 202',
            );
          }
        } catch (err) {
          request.log.warn(
            { err, banterInternalUrl },
            'Bureau leave-note: banter internal DM unreachable; falling back to 202',
          );
        }
      } else {
        request.log.warn(
          'Bureau leave-note: INTERNAL_SERVICE_SECRET not configured; cannot reach banter-api',
        );
      }

      // 202 when undelivered, 200 when delivered. Keeps the contract
      // useful for clients ("note was queued / dropped" vs "note delivered").
      const status = delivered ? 200 : 202;
      return reply.status(status).send({ data: { delivered } });
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
