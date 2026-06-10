/**
 * Internal cross-app routes for Bureau (Agent C, workstream 2).
 *
 * These endpoints are NOT user-facing. They are called by other BigBlueBam
 * services (board-api, brief-api, ...) over the internal network and are
 * authenticated by the shared INTERNAL_SERVICE_SECRET header
 * (`X-Internal-Service-Secret`). The session cookie / API key auth path
 * does NOT apply — the secret IS the credential.
 *
 * Why this exists:
 *   When the frontend follows a summon link like `/board/X?lkRoom=bureau-room-Y`,
 *   board-api needs to mint a LiveKit token for the Bureau room (so the
 *   continuous-audio call survives the cross-app navigation). Before
 *   minting, board-api must confirm the asking user is actually allowed
 *   to be in that Bureau room. This endpoint is that authority check —
 *   it never returns the LiveKit token itself, only an `allowed` boolean.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { timingSafeEqual } from 'node:crypto';
import { db } from '../db/index.js';
import { env } from '../env.js';
import { organizationMemberships } from '../db/schema/index.js';
import { bureauRooms, bureauRoomAcl } from '../db/schema/bureau.js';

// ─────────────────────────────────────────────────────────────────────
// Internal-secret guard.
//
// Mirrors apps/api/src/routes/internal-blueprint-sync.routes.ts so the
// posture is identical across services: timing-safe compare against
// env.INTERNAL_SERVICE_SECRET, reject 401 if absent or mismatched, and
// reject 503 if the secret is not configured (fail-closed — never
// accept the request).
// ─────────────────────────────────────────────────────────────────────

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Constant-time op against ourselves so length mismatch doesn't leak via timing.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function getInternalSecretHeader(request: FastifyRequest): string | undefined {
  const header = request.headers['x-internal-service-secret'];
  if (typeof header === 'string' && header.length > 0) return header;
  if (Array.isArray(header) && header.length > 0) return header[0];
  return undefined;
}

async function requireInternalSecret(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<boolean> {
  const expected = env.INTERNAL_SERVICE_SECRET;
  if (!expected) {
    // Fail closed: if the env var is unset, no caller can authenticate.
    await reply.status(503).send({
      error: {
        code: 'INTERNAL_AUTH_UNCONFIGURED',
        message: 'Internal service secret is not configured on this Bureau API instance',
        details: [],
        request_id: request.id,
      },
    });
    return false;
  }
  const provided = getInternalSecretHeader(request);
  if (!provided || !timingSafeStringEqual(provided, expected)) {
    await reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Invalid or missing internal service secret',
        details: [],
        request_id: request.id,
      },
    });
    return false;
  }
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// Schemas
// ─────────────────────────────────────────────────────────────────────

const paramsSchema = z.object({
  roomId: z.string().uuid(),
  userId: z.string().uuid(),
});

// ─────────────────────────────────────────────────────────────────────
// Route registration
// ─────────────────────────────────────────────────────────────────────

export default async function internalRoutes(fastify: FastifyInstance) {
  /**
   * GET /v1/internal/can-join-room/:roomId/:userId
   *
   * Returns { allowed: boolean, reason?: string }.
   *
   * Rules (per design doc §5 cross-app + §7 room access):
   *   - 404-equivalent denial (allowed=false, reason='room_not_found') if
   *     the room does not exist or is archived.
   *   - allowed=true if the room is an office and the user is owner_id.
   *   - allowed=true if there is a bureau_room_acl row for (room, user)
   *     — this covers private rooms with explicit grants AND offices
   *     where the owner has invited additional occupants.
   *   - allowed=true if the room's privacy_default is 'open' and the user
   *     has any matching org membership in the room's org_id.
   *   - otherwise allowed=false with a structured `reason` so the caller
   *     can surface a useful message ("knock_required" / "private_room"
   *     / "not_org_member").
   *
   * This endpoint NEVER throws on a missing-user vs missing-room
   * distinction — both collapse to allowed=false with reason. Callers
   * should treat the result as authoritative.
   */
  fastify.get(
    '/internal/can-join-room/:roomId/:userId',
    async (request, reply) => {
      if (!(await requireInternalSecret(request, reply))) return;

      const parsed = paramsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid roomId or userId',
            details: parsed.error.errors.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
            request_id: request.id,
          },
        });
      }

      const { roomId, userId } = parsed.data;

      // 1. Load the room. If it does not exist or is archived, deny.
      const [room] = await db
        .select({
          id: bureauRooms.id,
          org_id: bureauRooms.org_id,
          type: bureauRooms.type,
          privacy_default: bureauRooms.privacy_default,
          owner_id: bureauRooms.owner_id,
          archived_at: bureauRooms.archived_at,
        })
        .from(bureauRooms)
        .where(eq(bureauRooms.id, roomId))
        .limit(1);

      if (!room || room.archived_at !== null) {
        return reply.status(200).send({
          data: { allowed: false, reason: 'room_not_found' },
        });
      }

      // 2. Office owner always has access.
      if (room.type === 'office' && room.owner_id === userId) {
        return reply.status(200).send({ data: { allowed: true } });
      }

      // 3. Explicit ACL grant — covers private rooms and shared offices.
      const [aclRow] = await db
        .select({ id: bureauRoomAcl.id })
        .from(bureauRoomAcl)
        .where(
          and(
            eq(bureauRoomAcl.room_id, roomId),
            eq(bureauRoomAcl.user_id, userId),
          ),
        )
        .limit(1);

      if (aclRow) {
        return reply.status(200).send({ data: { allowed: true } });
      }

      // 4. Open privacy_default + same-org membership = allowed.
      //    For knock/private rooms we deny here — the visitor must go
      //    through the knock flow (or be on the ACL for private rooms).
      if (room.privacy_default === 'open') {
        const [membership] = await db
          .select({ id: organizationMemberships.id })
          .from(organizationMemberships)
          .where(
            and(
              eq(organizationMemberships.user_id, userId),
              eq(organizationMemberships.org_id, room.org_id),
            ),
          )
          .limit(1);

        if (membership) {
          return reply.status(200).send({ data: { allowed: true } });
        }
        return reply
          .status(200)
          .send({ data: { allowed: false, reason: 'not_org_member' } });
      }

      // 5. Knock-required / private fallbacks.
      if (room.privacy_default === 'knock') {
        return reply
          .status(200)
          .send({ data: { allowed: false, reason: 'knock_required' } });
      }

      return reply
        .status(200)
        .send({ data: { allowed: false, reason: 'private_room' } });
    },
  );
}
