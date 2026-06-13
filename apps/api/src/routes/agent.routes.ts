import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { activityLog } from '../db/schema/activity-log.js';
import { agentRunners } from '../db/schema/agent-runners.js';
import { users } from '../db/schema/users.js';
import { requireAuth, type AuthUser } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';

/**
 * Agent identity / audit / heartbeat routes (AGENTIC_TODO §10, Wave 1).
 *
 * Surface:
 *   POST /v1/agents/heartbeat       (service-account only — upsert agent_runners)
 *   POST /v1/agents/self-report     (service-account only — append activity_log)
 *   GET  /v1/agents/:id/audit       (any authed user, org-scoped — read activity_log)
 *   GET  /v1/agents                 (any authed user — list runners in caller's org)
 *
 * Canonical "is this caller a service account?" check goes through
 * `request.user.kind === 'service'`. The legacy bbam_svc_ key-prefix check
 * is no longer authoritative post-migration 0127; the users.kind column is.
 */

const heartbeatSchema = z.object({
  runner_name: z.string().min(1).max(200),
  version: z.string().max(100).optional(),
  capabilities: z.array(z.string().min(1).max(200)).max(256).optional(),
});

const selfReportSchema = z.object({
  summary: z.string().min(1).max(4000),
  metrics: z.record(z.unknown()).optional(),
  project_id: z.string().uuid(),
});

function requireServiceKind(request: FastifyRequest, reply: FastifyReply): boolean {
  const user = request.user as AuthUser | null;
  if (!user) {
    reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        details: [],
        request_id: request.id,
      },
    });
    return false;
  }
  if (user.kind !== 'service') {
    reply.status(403).send({
      error: {
        code: 'NOT_A_SERVICE_ACCOUNT',
        message: 'This endpoint requires a service-account caller (users.kind = service)',
        details: [],
        request_id: request.id,
      },
    });
    return false;
  }
  return true;
}

export default async function agentRoutes(fastify: FastifyInstance) {
  // ────────────────────────────────────────────────────────────────────
  // POST /v1/agents/heartbeat
  // ────────────────────────────────────────────────────────────────────
  fastify.post(
    '/v1/agents/heartbeat',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      if (!requireServiceKind(request, reply)) return;

      const parsed = heartbeatSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid heartbeat payload',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }

      const user = request.user!;
      const { runner_name, version, capabilities } = parsed.data;
      const now = new Date();

      // Upsert by user_id. The unique index on agent_runners(user_id) means
      // one row per service-account user; heartbeats overwrite the existing
      // row's mutable fields while preserving first_seen_at and id.
      const existing = await db
        .select()
        .from(agentRunners)
        .where(eq(agentRunners.user_id, user.id))
        .limit(1);

      let row;
      if (existing.length > 0) {
        const updated = await db
          .update(agentRunners)
          .set({
            name: runner_name,
            version: version ?? null,
            capabilities: capabilities ?? existing[0]!.capabilities,
            last_heartbeat_at: now,
            updated_at: now,
            // Intentionally do NOT touch org_id — the service account is
            // pinned to whatever org it was created under; a heartbeat
            // never changes that.
          })
          .where(eq(agentRunners.user_id, user.id))
          .returning();
        row = updated[0]!;
      } else {
        const inserted = await db
          .insert(agentRunners)
          .values({
            org_id: user.active_org_id,
            user_id: user.id,
            name: runner_name,
            version: version ?? null,
            capabilities: capabilities ?? [],
            last_heartbeat_at: now,
            first_seen_at: now,
          })
          .returning();
        row = inserted[0]!;
      }

      return reply.send({ data: row });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /v1/agents/self-report
  // ────────────────────────────────────────────────────────────────────
  //
  // Resolved open question 1: project_id is REQUIRED. The platform intentionally
  // does not create sentinel projects and does not make activity_log.project_id
  // nullable; a caller that needs to self-report must pick a project to scope it
  // under.
  fastify.post(
    '/v1/agents/self-report',
    { preHandler: [requireAuth, shadowOnly('bam.agent_self_report.create')] },
    async (request, reply) => {
      if (!requireServiceKind(request, reply)) return;

      const parsed = selfReportSchema.safeParse(request.body);
      if (!parsed.success) {
        const hasProject = parsed.error.issues.some((i) => i.path.join('.') === 'project_id');
        return reply.status(400).send({
          error: {
            code: hasProject ? 'PROJECT_ID_REQUIRED' : 'VALIDATION_ERROR',
            message: hasProject
              ? 'project_id is required for agent self-report (no sentinel projects in Wave 1)'
              : 'Invalid self-report payload',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }

      const user = request.user!;
      const { summary, metrics, project_id } = parsed.data;

      const [entry] = await db
        .insert(activityLog)
        .values({
          project_id,
          actor_id: user.id,
          actor_type: 'service',
          action: 'agent.self_report',
          details: {
            summary,
            ...(metrics ? { metrics } : {}),
          },
        })
        .returning();

      return reply.status(201).send({ data: entry });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // GET /v1/agents/:agent_user_id/audit
  // ────────────────────────────────────────────────────────────────────
  //
  // Resolved open question 2: Wave 1 scope is activity_log only. Bond/helpdesk/
  // banter/ticket activity are separate tables and a unified audit view is
  // Wave 2 work.
  // TODO (Wave 2): fan out and merge ticket_activity_log, bond_activities,
  // brief activity, etc., into a normalized stream.
  fastify.get<{
    Params: { agent_user_id: string };
    Querystring: { since?: string; limit?: string; cursor?: string };
  }>(
    '/v1/agents/:agent_user_id/audit',
    { preHandler: [requireAuth, shadowOnly('bam.agent_audit.get')] },
    async (request, reply) => {
      const callerOrgId = request.user!.active_org_id;
      const { agent_user_id } = request.params;

      // Verify the target agent belongs to the caller's active org. This is a
      // 404 rather than a 403 so we do not disclose existence of agents in
      // other orgs via timing / response-code probes.
      const targetRow = await db
        .select({ org_id: users.org_id, kind: users.kind })
        .from(users)
        .where(eq(users.id, agent_user_id))
        .limit(1);

      if (targetRow.length === 0 || targetRow[0]!.org_id !== callerOrgId) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Agent user not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const limit = Math.min(
        request.query.limit ? Number.parseInt(request.query.limit, 10) : 50,
        200,
      );

      const conditions = [eq(activityLog.actor_id, agent_user_id)];

      if (request.query.since) {
        const sinceDate = new Date(request.query.since);
        if (!Number.isNaN(sinceDate.getTime())) {
          conditions.push(gte(activityLog.created_at, sinceDate));
        }
      }
      if (request.query.cursor) {
        const cursorDate = new Date(request.query.cursor);
        if (!Number.isNaN(cursorDate.getTime())) {
          conditions.push(lt(activityLog.created_at, cursorDate));
        }
      }

      const rows = await db
        .select()
        .from(activityLog)
        .where(and(...conditions))
        .orderBy(desc(activityLog.created_at), desc(activityLog.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor =
        hasMore && data.length > 0
          ? data[data.length - 1]!.created_at.toISOString()
          : null;

      return reply.send({
        data,
        meta: {
          next_cursor: nextCursor,
          has_more: hasMore,
        },
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // GET /v1/agents
  // ────────────────────────────────────────────────────────────────────
  //
  // Any authenticated user can list runners in their active org. Liveness
  // filtering (last_heartbeat_at within TTL) is a Wave 2 addition — for now
  // we expose the raw timestamp and let callers decide.
  fastify.get(
    '/v1/agents',
    { preHandler: [requireAuth, shadowOnly('bam.agent.list')] },
    async (request, reply) => {
      const orgId = request.user!.active_org_id;

      const rows = await db
        .select()
        .from(agentRunners)
        .where(eq(agentRunners.org_id, orgId))
        .orderBy(sql`${agentRunners.last_heartbeat_at} DESC NULLS LAST`);

      return reply.send({ data: rows });
    },
  );
}
