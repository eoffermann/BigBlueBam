import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  BASTION_ROOM_PASSCODE_HEADER,
  BASTION_ROOM_RATE_PER_MINUTE,
  BASTION_ROOM_TOKEN_HEADER,
  bastionPublicRoomRequestSchema,
} from '@bigbluebam/shared';
import { handled, idParam, validationError } from '../lib/http.js';
import { roomDeps } from '../services/evidence-runtime.js';
import {
  ROOM_GONE,
  RoomPasscodeRequired,
  type RoomRequestContext,
  publicRoomControl,
  publicRoomDownload,
  publicRoomEvidence,
  publicRoomOverview,
  publicRoomRequest,
} from '../services/room.service.js';

// Spec 5.1 rows 101-104, 5.2 (M9): the public auditor room. NOT a user route: no session, no API
// key, no requireCan. The room token (from the URL fragment, sent as X-Bastion-Room-Token) is the
// credential; the service resolves it through bastion_resolve_room, re-checks the creator's
// permission, the expiry, revocation, lock and passcode on every request, and logs every view.
// 120 requests a minute per resolved client address (trustProxy = BASTION_TRUST_PROXY_HOPS).
// test/routes-permissions.test.ts checks this file separately.
export default async function publicRoomRoutes(fastify: FastifyInstance) {
  const deps = () => roomDeps(fastify.log, fastify.redis, (userId, orgId, p) => fastify.bastionUserCan(userId, orgId, p));
  const limit = { rateLimit: { max: BASTION_ROOM_RATE_PER_MINUTE, timeWindow: 60_000 } };
  const header = (request: FastifyRequest, name: string): string | null => {
    const v = request.headers[name];
    return typeof v === 'string' && v.length > 0 ? v.trim() : null;
  };
  const ctxOf = (request: FastifyRequest): RoomRequestContext => ({
    token: header(request, BASTION_ROOM_TOKEN_HEADER),
    passcode: header(request, BASTION_ROOM_PASSCODE_HEADER),
    ip: request.ip,
    userAgent: header(request, 'user-agent'),
  });
  // Missing, revoked, expired and locked rooms are one indistinguishable 404 (spec 5.2).
  const run = async <T>(request: FastifyRequest, reply: FastifyReply, fn: () => Promise<T>) => {
    try {
      return await handled(request, reply, fn);
    } catch (err) {
      if (err instanceof RoomPasscodeRequired) {
        return reply.status(401).send({
          error: {
            code: err.wrong ? 'PASSCODE_WRONG' : 'PASSCODE_REQUIRED',
            message: err.message,
            details: err.attemptsLeft !== null ? [{ field: 'passcode', issue: `attempts_left:${err.attemptsLeft}` }] : [],
            request_id: request.id,
          },
        });
      }
      throw err;
    }
  };
  const gone = (request: FastifyRequest, reply: FastifyReply) =>
    reply.status(404).send({ error: { code: 'NOT_FOUND', message: ROOM_GONE, details: [], request_id: request.id } });

  // Row 101.
  fastify.get('/public/room', { config: limit }, async (request, reply) => run(request, reply, () => publicRoomOverview(deps(), ctxOf(request))));

  // Row 102.
  fastify.get('/public/room/controls/:id', { config: limit }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return gone(request, reply);
    return run(request, reply, () => publicRoomControl(deps(), ctxOf(request), id));
  });

  // Row 103 (+ ?download=1 for the bytes, spec 5.1 byte-response headers).
  fastify.get('/public/room/evidence/:id', { config: limit }, async (request, reply) => {
    const id = idParam(request);
    if (!id) return gone(request, reply);
    const download = (request.query as Record<string, string | undefined> | undefined)?.download === '1';
    if (!download) return run(request, reply, () => publicRoomEvidence(deps(), ctxOf(request), id));
    return run(request, reply, async () => {
      const file = await publicRoomDownload(deps(), ctxOf(request), id);
      for (const [k, v] of Object.entries(file.headers)) reply.header(k, v);
      return reply.send(file.stream);
    });
  });

  // Row 104: an auditor's question (20 an hour per room).
  fastify.post('/public/room/requests', { config: limit, bodyLimit: 16 * 1024 }, async (request, reply) => {
    const parsed = bastionPublicRoomRequestSchema.safeParse(request.body ?? {});
    if (!parsed.success) return validationError(request, reply, parsed.error);
    return run(request, reply, async () => {
      const out = await publicRoomRequest(deps(), ctxOf(request), parsed.data);
      reply.status(201);
      return out;
    });
  });
}
