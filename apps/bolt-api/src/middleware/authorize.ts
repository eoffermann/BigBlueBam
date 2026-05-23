import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { boltAutomations } from '../db/schema/index.js';

const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function roleLevel(role: string): number {
  const idx = ROLE_HIERARCHY.indexOf(role as (typeof ROLE_HIERARCHY)[number]);
  return idx >= 0 ? idx : -1;
}


declare module 'fastify' {
  interface FastifyRequest {
    automation?: {
      id: string;
      org_id: string;
      project_id: string | null;
      name: string;
      description: string | null;
      enabled: boolean;
      trigger_source: string;
      trigger_event: string;
      trigger_filter: unknown;
      cron_expression: string | null;
      cron_timezone: string;
      max_executions_per_hour: number;
      cooldown_seconds: number;
      last_executed_at: Date | null;
      created_by: string;
      updated_by: string | null;
      created_at: Date;
      updated_at: Date;
      [key: string]: unknown;
    };
  }
}

/**
 * Automation read-access guard.
 *
 * Loads an automation by :id param, checks org isolation,
 * and attaches to `request.automation` for downstream handlers.
 */
export function requireAutomationAccess() {
  return async function checkAutomationAccess(request: FastifyRequest, reply: FastifyReply) {
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
          message: 'Valid automation id is required',
          details: [],
          request_id: request.id,
        },
      });
    }

    const [automation] = await db
      .select()
      .from(boltAutomations)
      .where(eq(boltAutomations.id, id))
      .limit(1);

    if (!automation) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Automation not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Org isolation
    if (automation.org_id !== request.user.org_id && !request.user.is_superuser) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Automation not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    (request as any).automation = automation;
  };
}

/**
 * Automation edit-access guard.
 *
 * Extends read access to verify the user has edit permission:
 *   - SuperUser: always allowed
 *   - Admin / Owner (org role): allowed on any automation in their org
 *   - Creator: always allowed on own automations
 *   - Everyone else: denied
 */
export function requireAutomationEditAccess() {
  return async function checkAutomationEditAccess(request: FastifyRequest, reply: FastifyReply) {
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
          message: 'Valid automation id is required',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Load automation if not already loaded by a prior middleware
    let automation = (request as any).automation;
    if (!automation) {
      const [found] = await db
        .select()
        .from(boltAutomations)
        .where(eq(boltAutomations.id, id))
        .limit(1);

      if (!found) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Automation not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      automation = found;
      (request as any).automation = automation;
    }

    // Org isolation
    if (automation.org_id !== request.user.org_id && !request.user.is_superuser) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Automation not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    if (request.user.is_superuser) return;

    // Admin / Owner org role can edit any automation in org
    if (roleLevel(request.user.role) >= roleLevel('admin')) return;

    // Creator can always edit
    if (automation.created_by === request.user.id) return;

    return reply.status(403).send({
      error: {
        code: 'FORBIDDEN',
        message: 'You do not have permission to modify this automation',
        details: [],
        request_id: request.id,
      },
    });
  };
}
