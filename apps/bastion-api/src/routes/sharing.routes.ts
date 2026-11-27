import type { FastifyInstance } from 'fastify';
import {
  bastionAccessLogQuerySchema,
  bastionAuditorRequestListQuerySchema,
  bastionAuditorRequestUpdateSchema,
  bastionAuditorRoomCreateSchema,
  bastionAuditorRoomListQuerySchema,
  bastionAuditorRoomRevokeSchema,
  bastionAuditorRoomUnlockSchema,
  bastionExportCreateSchema,
  bastionExportListQuerySchema,
} from '@bigbluebam/shared';
import { rejectWhenImpersonating, requireAuth, requireSession } from '../plugins/auth.js';
import { handled, idParam, notFound, validationError, viewerOf } from '../lib/http.js';
import { sharingDeps } from '../services/evidence-runtime.js';
import * as sharing from '../services/sharing.service.js';

// Spec 5.1 rows 84-93 (M9): auditor rooms, auditors' questions and audit packets, plus the
// creator's Preview of a room (GET /auditor-rooms/:id/preview, outside spec 5.1; it renders the
// same overview the auditor sees, without logging a visit).
//
// Room create, revoke and unlock are disclosure acts (spec 2.8, #136): session-only and never
// impersonated, before requireCan, so no API key or agent can open or close a room. Everything
// else here an agent may do through an API key under the same permissions.
export default async function sharingRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);
  const deps = () => sharingDeps(fastify.log, fastify.redis);
  const query = (request: { query: unknown }) => {
    const raw = (request.query ?? {}) as Record<string, string | undefined>;
    return Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined && v !== ''));
  };
  const restricted = (request: Parameters<typeof fastify.bastionCan>[0]) => fastify.bastionCan(request, 'bastion.evidence.read_restricted');

  // Row 84.
  fastify.get('/auditor-rooms', { preHandler: [requireAuth, can('bastion.auditor_room.read')] }, async (request, reply) => {
    const parsed = bastionAuditorRoomListQuerySchema.safeParse(query(request));
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => sharing.listRooms(deps(), viewerOf(request), parsed.data));
  });

  // Row 85: the token is in the response once and never stored.
  fastify.post(
    '/auditor-rooms',
    { preHandler: [requireAuth, requireSession, rejectWhenImpersonating, can('bastion.auditor_room.create')] },
    async (request, reply) => {
      const parsed = bastionAuditorRoomCreateSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      const canRestricted = await restricted(request);
      return handled(request, reply, async () => {
        const out = await sharing.createRoom(deps(), viewerOf(request), parsed.data, canRestricted);
        reply.status(201);
        return out;
      });
    },
  );

  // Row 86.
  fastify.post(
    '/auditor-rooms/:id/revoke',
    { preHandler: [requireAuth, requireSession, rejectWhenImpersonating, can('bastion.auditor_room.revoke')] },
    async (request, reply) => {
      const id = idParam(request);
      if (!id) return notFound(request, reply);
      const parsed = bastionAuditorRoomRevokeSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      return handled(request, reply, () => sharing.revokeRoom(deps(), viewerOf(request), id));
    },
  );

  // Row 87: after 5 wrong passcodes locked the room.
  fastify.post(
    '/auditor-rooms/:id/unlock',
    { preHandler: [requireAuth, requireSession, rejectWhenImpersonating, can('bastion.auditor_room.create')] },
    async (request, reply) => {
      const id = idParam(request);
      if (!id) return notFound(request, reply);
      const parsed = bastionAuditorRoomUnlockSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      return handled(request, reply, () => sharing.unlockRoom(deps(), viewerOf(request), id));
    },
  );

  // Row 88.
  fastify.get('/auditor-rooms/:id/access-log', { preHandler: [requireAuth, can('bastion.auditor_room.read')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionAccessLogQuerySchema.safeParse(query(request));
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => sharing.roomAccessLog(deps(), viewerOf(request), id, parsed.data));
  });

  // Preview: exactly what the auditor sees (story 8).
  fastify.get('/auditor-rooms/:id/preview', { preHandler: [requireAuth, can('bastion.auditor_room.read')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    return handled(request, reply, () => sharing.previewRoom(deps(), viewerOf(request), id));
  });

  // Row 89.
  fastify.get('/auditor-requests', { preHandler: [requireAuth, can('bastion.auditor_room.read')] }, async (request, reply) => {
    const parsed = bastionAuditorRequestListQuerySchema.safeParse(query(request));
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => sharing.listRequests(deps(), viewerOf(request), parsed.data));
  });

  // Row 90.
  fastify.patch('/auditor-requests/:id', { preHandler: [requireAuth, can('bastion.auditor_room.respond')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const parsed = bastionAuditorRequestUpdateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => sharing.updateRequest(deps(), viewerOf(request), id, parsed.data));
  });

  // Row 91 (202): the worker builds the packet.
  fastify.post('/exports', { preHandler: [requireAuth, can('bastion.export.create')] }, async (request, reply) => {
    const parsed = bastionExportCreateSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    const canRestricted = await restricted(request);
    return handled(request, reply, async () => {
      const out = await sharing.createExport(deps(), viewerOf(request), parsed.data, canRestricted);
      reply.status(202);
      return out;
    });
  });

  // Row 92.
  fastify.get('/exports', { preHandler: [requireAuth, can('bastion.export.read')] }, async (request, reply) => {
    const parsed = bastionExportListQuerySchema.safeParse(query(request));
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return handled(request, reply, () => sharing.listExports(deps(), viewerOf(request), parsed.data));
  });

  // #402: hide a packet that could not be built (soft, audited; a built packet is refused).
  fastify.post('/exports/:id/dismiss', { preHandler: [requireAuth, can('bastion.export.create')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    return handled(request, reply, () => sharing.dismissExport(deps(), viewerOf(request), id));
  });

  // Row 93: the zip (spec 5.1 byte-response headers).
  fastify.get('/exports/:id/download', { preHandler: [requireAuth, can('bastion.export.read')] }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return notFound(request, reply);
    const canRestricted = await restricted(request);
    return handled(request, reply, async () => {
      const file = await sharing.openExportDownload(deps(), viewerOf(request), id, canRestricted);
      for (const [k, v] of Object.entries(file.headers)) reply.header(k, v);
      return reply.send(file.stream);
    });
  });
}
