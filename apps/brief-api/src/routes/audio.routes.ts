import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';
import { requireDocumentAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import { generateBriefAudioToken, isValidBureauRoomName } from '../services/livekit.service.js';

// Bureau §9 Strategy B (continuous-audio teleport).
//
// Brief has no native call surface (P-6 stub), so the *only* legitimate
// reason to mint a LiveKit token from this route is a Bureau summon. The
// frontend reads `?lkRoom=` from the URL, validates the format, and posts
// the value here. We re-validate the format server-side (defense in depth)
// before minting a token scoped to that room name.
//
// Permission model: the caller must have document read access (org
// membership + visibility) via the standard requireDocumentAccess()
// middleware. Bureau owns the question of whether the caller actually
// belongs in the bureau room — once bureau-api lands, this route should
// additionally hit its internal `/v1/internal/can-join-room/:roomId/:userId`
// endpoint. Until then the format gate plus document-access gate is the
// barrier (the room UUIDs are non-enumerable).
const audioTokenBody = z.object({
  lk_room: z.string().min(8).max(96),
});

export default async function audioRoutes(fastify: FastifyInstance) {
  // POST /v1/documents/:id/audio/token — mint a LiveKit JWT for a Bureau
  // continuous-audio summon landing on this Brief doc.
  fastify.post(
    '/documents/:id/audio/token',
    {
      preHandler: [
        requireAuth,
        requireDocumentAccess(),
        shadowOnly('brief.document_audio_token.create'),
      ],
    },
    async (request, reply) => {
      const user = request.user!;
      const doc = request.document!;

      const parsed = audioTokenBody.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'lk_room is required',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }

      const { lk_room } = parsed.data;
      if (!isValidBureauRoomName(lk_room)) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message:
              'lk_room must match bureau-room-<uuid> (Bureau §9 Strategy B is the only supported source)',
            details: [{ field: 'lk_room', issue: 'invalid format' }],
            request_id: request.id,
          },
        });
      }

      try {
        const result = await generateBriefAudioToken(
          doc.id,
          user.id,
          user.display_name,
          lk_room,
        );

        return reply.status(200).send({
          data: {
            token: result.token,
            room_name: result.roomName,
            ws_url: result.wsUrl,
          },
        });
      } catch (err) {
        request.log.error({ err, document_id: doc.id }, 'Failed to mint Brief audio token');
        return reply.status(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to mint audio token',
            details: [],
            request_id: request.id,
          },
        });
      }
    },
  );
}
