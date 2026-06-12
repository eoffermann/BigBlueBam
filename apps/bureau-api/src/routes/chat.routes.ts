/**
 * Bureau room-chat REST surface — the recovery half of the feature (the
 * live half is WS: chat_join / chat_send / chat_message in ws.routes.ts).
 *
 *   GET   /v1/chat/rooms?search=        threads the caller participated in
 *   GET   /v1/chat/rooms/:roomKey/messages   transcript (participant/admin)
 *   PATCH /v1/chat/rooms/:roomKey/retention  extend ≤168h or retain forever
 *                                            (org admin / SuperUser only)
 *
 * Access model: participation (recorded when a widget joins the room's
 * chat) is what entitles recovery — you can re-read what you were present
 * for. Org admins and SuperUsers can additionally read any thread they
 * can name and set retention; retention extension is capped at one week
 * unless retain_forever is chosen.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';
import * as chat from '../services/chat.service.js';

const retentionSchema = z
  .object({
    retention_hours: z.number().int().min(1).max(chat.MAX_RETENTION_HOURS).optional(),
    retain_forever: z.boolean().optional(),
  })
  .refine((v) => v.retention_hours !== undefined || v.retain_forever !== undefined, {
    message: 'Provide retention_hours or retain_forever',
  });

function isOrgAdmin(user: { role?: string | null; is_superuser?: boolean }): boolean {
  return user.is_superuser === true || user.role === 'admin' || user.role === 'owner';
}

export default async function chatRoutes(fastify: FastifyInstance) {
  fastify.get<{ Querystring: { search?: string } }>(
    '/chat/rooms',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      const rooms = await chat.listRoomsForUser(
        user.org_id,
        user.id,
        request.query.search,
      );
      return reply.send({ data: rooms });
    },
  );

  fastify.get<{ Params: { roomKey: string }; Querystring: { before?: string; limit?: string } }>(
    '/chat/rooms/:roomKey/messages',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      const roomKey = request.params.roomKey;
      if (!chat.ROOM_KEY_RE.test(roomKey)) {
        return reply.status(400).send({
          error: { code: 'BAD_CHAT_ROOM', message: 'Invalid room key', details: [], request_id: request.id },
        });
      }
      const allowed =
        isOrgAdmin(user) || (await chat.isParticipant(user.org_id, roomKey, user.id));
      if (!allowed) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'You were not part of this chat',
            details: [],
            request_id: request.id,
          },
        });
      }
      const before = request.query.before ? new Date(request.query.before) : undefined;
      const limit = request.query.limit
        ? Math.min(parseInt(request.query.limit, 10) || 50, 200)
        : 100;
      const messages = await chat.listRecentMessages(user.org_id, roomKey, limit, before);
      const avatars = await chat.loadAuthorAvatars(
        messages.map((m) => m.author_id).filter((id): id is string => !!id),
      );
      return reply.send({
        data: messages.map((m) => ({
          ...m,
          author_avatar_url: m.author_id ? avatars.get(m.author_id) ?? null : null,
        })),
      });
    },
  );

  fastify.patch<{ Params: { roomKey: string } }>(
    '/chat/rooms/:roomKey/retention',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      if (!isOrgAdmin(user)) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Retention can only be changed by an org admin/owner or SuperUser',
            details: [],
            request_id: request.id,
          },
        });
      }
      const roomKey = request.params.roomKey;
      if (!chat.ROOM_KEY_RE.test(roomKey)) {
        return reply.status(400).send({
          error: { code: 'BAD_CHAT_ROOM', message: 'Invalid room key', details: [], request_id: request.id },
        });
      }
      const parsed = retentionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid retention payload',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }
      const updated = await chat.setRetention(user.org_id, roomKey, parsed.data);
      if (!updated) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Chat not found', details: [], request_id: request.id },
        });
      }
      return reply.send({ data: updated });
    },
  );
}
