import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  boards,
  boardCollaborators,
  projectMembers,
} from '../db/schema/index.js';

const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function roleLevel(role: string): number {
  const idx = ROLE_HIERARCHY.indexOf(role as (typeof ROLE_HIERARCHY)[number]);
  return idx >= 0 ? idx : -1;
}


declare module 'fastify' {
  interface FastifyRequest {
    board?: {
      id: string;
      organization_id: string;
      project_id: string | null;
      name: string;
      description: string | null;
      icon: string | null;
      thumbnail_url: string | null;
      template_id: string | null;
      background: string;
      locked: boolean;
      visibility: string;
      default_viewport: unknown;
      created_by: string;
      updated_by: string | null;
      created_at: Date;
      updated_at: Date;
      archived_at: Date | null;
      [key: string]: unknown;
    };
  }
}

/**
 * Board read-access guard.
 *
 * Loads a board by :id param, checks org isolation, checks visibility
 * (private = owner + collaborators, project = project members, org = all org members),
 * and attaches to `request.board` for downstream handlers.
 */
export function requireBoardAccess() {
  return async function checkBoardAccess(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          details: [],
          request_id: request.id,
        },
      });
    }

    const { id } = request.params as { id: string };
    if (!id || !UUID_REGEX.test(id)) {
      return reply.status(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'Valid board id is required',
          details: [],
          request_id: request.id,
        },
      });
    }

    const [board] = await db
      .select()
      .from(boards)
      .where(eq(boards.id, id))
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

    // Org isolation
    if (board.organization_id !== request.user.org_id && !request.user.is_superuser) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Board not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // SuperUsers bypass visibility checks
    if (request.user.is_superuser) {
      (request as any).board = board;
      return;
    }

    // Owner always has access
    if (board.created_by === request.user.id) {
      (request as any).board = board;
      return;
    }

    // Org admins/owners always have access
    if (roleLevel(request.user.role) >= roleLevel('admin')) {
      (request as any).board = board;
      return;
    }

    // Visibility checks
    if (board.visibility === 'organization') {
      // All org members can access
      (request as any).board = board;
      return;
    }

    if (board.visibility === 'project') {
      // Check project membership
      if (board.project_id) {
        const [membership] = await db
          .select()
          .from(projectMembers)
          .where(
            and(
              eq(projectMembers.project_id, board.project_id),
              eq(projectMembers.user_id, request.user.id),
            ),
          )
          .limit(1);

        if (membership) {
          (request as any).board = board;
          return;
        }
      }

      // Also check if user is a collaborator
      const [collab] = await db
        .select()
        .from(boardCollaborators)
        .where(
          and(
            eq(boardCollaborators.board_id, id),
            eq(boardCollaborators.user_id, request.user.id),
          ),
        )
        .limit(1);

      if (collab) {
        (request as any).board = board;
        return;
      }

      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Board not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    if (board.visibility === 'private') {
      // Only owner + collaborators
      const [collab] = await db
        .select()
        .from(boardCollaborators)
        .where(
          and(
            eq(boardCollaborators.board_id, id),
            eq(boardCollaborators.user_id, request.user.id),
          ),
        )
        .limit(1);

      if (collab) {
        (request as any).board = board;
        return;
      }

      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Board not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Unknown visibility — deny
    return reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'Board not found',
        details: [],
        request_id: request.id,
      },
    });
  };
}

/**
 * Board edit-access guard.
 *
 * Extends read access to verify the user has edit permission:
 *   - SuperUser: always allowed
 *   - Admin / Owner (org role): allowed on any board in their org
 *   - Board creator: always allowed
 *   - Collaborator with 'edit' permission: allowed
 *   - Locked boards reject edits unless user is owner/admin
 */
export function requireBoardEditAccess() {
  return async function checkBoardEditAccess(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          details: [],
          request_id: request.id,
        },
      });
    }

    const { id } = request.params as { id: string };
    if (!id || !UUID_REGEX.test(id)) {
      return reply.status(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'Valid board id is required',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Load board if not already loaded by a prior middleware
    let board = (request as any).board;
    if (!board) {
      const [found] = await db
        .select()
        .from(boards)
        .where(eq(boards.id, id))
        .limit(1);

      if (!found) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Board not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      board = found;
      (request as any).board = board;
    }

    // Org isolation
    if (board.organization_id !== request.user.org_id && !request.user.is_superuser) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Board not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    if (request.user.is_superuser) return;

    const isOwnerOrAdmin =
      board.created_by === request.user.id ||
      roleLevel(request.user.role) >= roleLevel('admin');

    // Locked boards reject edits unless user is owner/admin
    if (board.locked && !isOwnerOrAdmin) {
      return reply.status(403).send({
        error: {
          code: 'FORBIDDEN',
          message: 'Board is locked. Only the owner or an admin can edit it.',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Admin / Owner org role can edit any board in org
    if (isOwnerOrAdmin) return;

    // Check collaborator with edit permission
    const [collab] = await db
      .select()
      .from(boardCollaborators)
      .where(
        and(
          eq(boardCollaborators.board_id, id),
          eq(boardCollaborators.user_id, request.user.id),
        ),
      )
      .limit(1);

    if (collab && collab.permission === 'edit') return;

    return reply.status(403).send({
      error: {
        code: 'FORBIDDEN',
        message: 'You do not have permission to edit this board',
        details: [],
        request_id: request.id,
      },
    });
  };
}
