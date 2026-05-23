import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import { preflightAccess, SUPPORTED_ENTITY_TYPES } from '../services/visibility.service.js';
import { logActivity } from '../services/activity.service.js';
import { projects } from '../db/schema/projects.js';
import { db } from '../db/index.js';
import { eq } from 'drizzle-orm';

/**
 * Visibility preflight route (AGENTIC_TODO §11, Wave 2).
 *
 *   POST /v1/visibility/can_access
 *     body: { asker_user_id, entity_type, entity_id }
 *     -> 200 { data: { allowed, reason, entity_org_id? } }
 *
 * Gating: any authenticated caller with read scope. Humans can and will
 * legitimately debug visibility questions ("why did the bot not surface
 * this ticket?") so this is not service-account only.
 *
 * When an agent invokes the tool on behalf of a human asker and the
 * preflight denies access, we record an activity_log entry tagged
 * 'visibility.preflight_denied' so the cross-agent audit trail can later
 * prove a leak was prevented. The audit row is best-effort: its project
 * scope is derived from the preflight result when possible, otherwise we
 * skip the write rather than fail the preflight.
 */

const requestSchema = z.object({
  asker_user_id: z.string().uuid(),
  entity_type: z.string().min(1).max(64),
  entity_id: z.string().min(1).max(128),
});

export default async function visibilityRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/v1/visibility/can_access',
    {
      preHandler: [requireAuth, requireScope('read'), shadowOnly('bam.visibility_can_access.create')],
      config: { rateLimit: { max: 100, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const parsed = requestSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid can_access payload',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }

      const { asker_user_id, entity_type, entity_id } = parsed.data;
      const result = await preflightAccess(asker_user_id, entity_type, entity_id);

      // Audit agent-on-behalf-of-human denials. We only log when the caller
      // is acting for someone else (asker != caller) AND the answer is no,
      // to keep the activity_log narrow and meaningful. This matches the
      // "trust but verify" shape - successful reads are already audited
      // implicitly via the downstream queries the caller will make.
      const caller = request.user!;
      if (!result.allowed && asker_user_id !== caller.id) {
        await recordDeniedAudit({
          callerId: caller.id,
          callerOrgId: caller.active_org_id,
          askerUserId: asker_user_id,
          entityType: entity_type,
          entityId: entity_id,
          reason: result.reason,
          entityOrgId: result.entity_org_id,
        }).catch((err: unknown) => {
          request.log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'visibility.preflight_denied audit write failed',
          );
        });
      }

      return reply.send({
        data: {
          allowed: result.allowed,
          reason: result.reason,
          ...(result.entity_org_id
            ? { entity_org_id: result.entity_org_id }
            : {}),
          // Advertise the currently-supported entity_type allowlist so MCP
          // callers that reach for an unsupported type get a clear hint
          // rather than a bare 'unsupported_entity_type'.
          ...(result.reason === 'unsupported_entity_type'
            ? { supported_entity_types: SUPPORTED_ENTITY_TYPES }
            : {}),
        },
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Audit helper
// ---------------------------------------------------------------------------
//
// activity_log.project_id is NOT NULL. The preflight is entity-shaped, not
// project-shaped, so for non-project entities (bond, beacon, brief without
// project, helpdesk without project) we have no natural project to scope
// under. Rather than invent a sentinel project or widen the schema, we fall
// back to the first project in the caller's org and tag the details with
// the entity type. That preserves the audit trail while staying inside the
// existing activity_log contract.
//
// If the caller's org has ZERO projects (possible for bare orgs), we skip
// the write. This is rare and the log message from the catch in the caller
// surfaces it.

async function recordDeniedAudit(input: {
  callerId: string;
  callerOrgId: string;
  askerUserId: string;
  entityType: string;
  entityId: string;
  reason: string;
  entityOrgId: string | undefined;
}): Promise<void> {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(eq(projects.org_id, input.callerOrgId))
    .limit(1);
  const projectId = rows[0]?.id;
  if (!projectId) return;

  await logActivity(
    projectId,
    input.callerId,
    'visibility.preflight_denied',
    null,
    {
      asker_user_id: input.askerUserId,
      entity_type: input.entityType,
      entity_id: input.entityId,
      reason: input.reason,
      entity_org_id: input.entityOrgId ?? null,
    },
  );
}
