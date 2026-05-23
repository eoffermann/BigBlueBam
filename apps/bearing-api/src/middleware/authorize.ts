import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { bearingGoals } from '../db/schema/index.js';

const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function roleLevel(role: string): number {
  const idx = ROLE_HIERARCHY.indexOf(role as (typeof ROLE_HIERARCHY)[number]);
  return idx >= 0 ? idx : -1;
}


declare module 'fastify' {
  interface FastifyRequest {
    goal?: {
      id: string;
      organization_id: string;
      period_id: string;
      scope: string;
      project_id: string | null;
      team_name: string | null;
      title: string;
      description: string | null;
      icon: string | null;
      color: string | null;
      status: string;
      status_override: boolean;
      progress: string;
      owner_id: string | null;
      created_by: string;
      created_at: Date;
      updated_at: Date;
      [key: string]: unknown;
    };
  }
}

/**
 * Goal read-access guard.
 *
 * Loads a goal by :id param, checks org isolation,
 * and attaches to `request.goal` for downstream handlers.
 */
export function requireGoalAccess() {
  return async function checkGoalAccess(request: FastifyRequest, reply: FastifyReply) {
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
          message: 'Valid goal id is required',
          details: [],
          request_id: request.id,
        },
      });
    }

    const [goal] = await db
      .select()
      .from(bearingGoals)
      .where(eq(bearingGoals.id, id))
      .limit(1);

    if (!goal) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Goal not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Org isolation
    if (goal.organization_id !== request.user.org_id && !request.user.is_superuser) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Goal not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    (request as any).goal = goal;
  };
}

/**
 * Goal edit-access guard.
 *
 * Extends read access to verify the user has edit permission:
 *   - SuperUser: always allowed
 *   - Admin / Owner (org role): allowed on any goal in their org
 *   - Creator: always allowed on own goals
 *   - Goal owner: allowed on their assigned goals
 *   - Everyone else: denied
 */
export function requireGoalEditAccess() {
  return async function checkGoalEditAccess(request: FastifyRequest, reply: FastifyReply) {
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
          message: 'Valid goal id is required',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Load goal if not already loaded by a prior middleware
    let goal = (request as any).goal;
    if (!goal) {
      const [found] = await db
        .select()
        .from(bearingGoals)
        .where(eq(bearingGoals.id, id))
        .limit(1);

      if (!found) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Goal not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      goal = found;
      (request as any).goal = goal;
    }

    // Org isolation
    if (goal.organization_id !== request.user.org_id && !request.user.is_superuser) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Goal not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    if (request.user.is_superuser) return;

    // Admin / Owner org role can edit any goal in org
    if (roleLevel(request.user.role) >= roleLevel('admin')) return;

    // Creator can always edit
    if (goal.created_by === request.user.id) return;

    // Goal owner can edit
    if (goal.owner_id === request.user.id) return;

    return reply.status(403).send({
      error: {
        code: 'FORBIDDEN',
        message: 'You do not have permission to modify this goal',
        details: [],
        request_id: request.id,
      },
    });
  };
}
