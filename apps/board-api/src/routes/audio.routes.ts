import type { FastifyInstance } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { boards, boardCollaborators, projectMembers } from '../db/schema/index.js';
import { requireAuth } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import { generateBoardAudioToken } from '../services/livekit.service.js';

// Bureau §9 Strategy B: when a user is summoned into a Bureau room
// with continuous audio, the summon target URL carries `?lkRoom=`. The
// frontend reads that and passes it here so Board mints a token for the
// Bureau room instead of the canonical board-{boardId} room and the
// call never drops during the cross-app navigation. Format validation
// + access auditing live in the service layer.
const audioTokenBody = z
  .object({
    lk_room: z.string().min(8).max(96).optional(),
  })
  .partial();

const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;

function roleLevel(role: string): number {
  const idx = ROLE_HIERARCHY.indexOf(role as (typeof ROLE_HIERARCHY)[number]);
  return idx >= 0 ? idx : -1;
}

export default async function audioRoutes(fastify: FastifyInstance) {
  // POST /v1/boards/:id/audio/token — get a LiveKit JWT for the board's audio room
  fastify.post(
    '/v1/boards/:id/audio/token',
    { preHandler: [requireAuth, shadowOnly('board.board_audio_token.create')] },
    async (request, reply) => {
      const { id: boardId } = request.params as { id: string };
      const user = request.user!;

      // Verify the board exists and belongs to the user's org
      const [board] = await db
        .select({
          id: boards.id,
          organization_id: boards.organization_id,
          visibility: boards.visibility,
          created_by: boards.created_by,
          project_id: boards.project_id,
        })
        .from(boards)
        .where(eq(boards.id, boardId))
        .limit(1);

      if (!board) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Board not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Check org membership
      if (board.organization_id !== user.org_id) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'You do not have access to this board',
            details: [],
            request_id: request.id,
          },
        });
      }

      // SuperUsers bypass visibility checks
      if (!user.is_superuser) {
        const isCreator = board.created_by === user.id;
        const isOrgAdminOrOwner = roleLevel(user.role) >= roleLevel('admin');

        if (board.visibility === 'private') {
          // Creator and org admins/owners always have access
          if (!isCreator && !isOrgAdminOrOwner) {
            const [collaborator] = await db
              .select({ id: boardCollaborators.id })
              .from(boardCollaborators)
              .where(
                and(
                  eq(boardCollaborators.board_id, boardId),
                  eq(boardCollaborators.user_id, user.id),
                ),
              )
              .limit(1);

            if (!collaborator) {
              return reply.status(403).send({
                error: {
                  code: 'FORBIDDEN',
                  message: 'You do not have access to this private board',
                  details: [],
                  request_id: request.id,
                },
              });
            }
          }
        } else if (board.visibility === 'project') {
          // Creator and org admins/owners always have access
          if (!isCreator && !isOrgAdminOrOwner) {
            let hasAccess = false;

            // Check project membership
            if (board.project_id) {
              const [membership] = await db
                .select({ id: projectMembers.id })
                .from(projectMembers)
                .where(
                  and(
                    eq(projectMembers.project_id, board.project_id),
                    eq(projectMembers.user_id, user.id),
                  ),
                )
                .limit(1);
              if (membership) hasAccess = true;
            }

            // Also check collaborator access
            if (!hasAccess) {
              const [collaborator] = await db
                .select({ id: boardCollaborators.id })
                .from(boardCollaborators)
                .where(
                  and(
                    eq(boardCollaborators.board_id, boardId),
                    eq(boardCollaborators.user_id, user.id),
                  ),
                )
                .limit(1);
              if (collaborator) hasAccess = true;
            }

            if (!hasAccess) {
              return reply.status(403).send({
                error: {
                  code: 'FORBIDDEN',
                  message: 'You do not have access to this board',
                  details: [],
                  request_id: request.id,
                },
              });
            }
          }
        }
        // 'organization' visibility: all org members have access (already verified above)
      }

      const body = audioTokenBody.parse(request.body ?? {});

      const result = await generateBoardAudioToken(
        boardId,
        user.id,
        user.display_name,
        body.lk_room,
      );

      return reply.status(200).send({
        data: {
          token: result.token,
          room_name: result.roomName,
          ws_url: result.wsUrl,
        },
      });
    },
  );
}
