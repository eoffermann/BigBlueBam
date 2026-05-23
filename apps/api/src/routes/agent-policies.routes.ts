import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import {
  checkPolicy,
  getPolicy,
  listPolicies,
  setPolicy,
} from '../services/agent-policy.service.js';

/**
 * Agent-policy REST routes (AGENTIC_TODO §15, Wave 5).
 *
 *   GET  /v1/agent-policies/:agent_user_id
 *   POST /v1/agent-policies/:agent_user_id        (upsert)
 *   GET  /v1/agent-policies                       (list for caller's org)
 *   POST /v1/agent-policies/:agent_user_id/check  (internal: tool-name check)
 *
 * The /check endpoint is used by the MCP register-tool wrapper to decide
 * whether a given service-account caller may invoke a given tool. It runs
 * through the same `requireAuth` gate as the other routes because the MCP
 * server calls it with a service-account bearer token, not a shared secret.
 * Anyone with a valid session CAN call it; the response only surfaces the
 * allow/deny decision, no secrets.
 */

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  allowed_tools: z.array(z.string().min(1).max(200)).max(512).optional(),
  channel_subscriptions: z.array(z.string().uuid()).max(512).optional(),
  rate_limit_override: z.number().int().positive().nullable().optional(),
  notes: z.string().max(4000).nullable().optional(),
});

const listQuerySchema = z.object({
  org_id: z.string().uuid().optional(),
  enabled_only: z
    .preprocess((v) => {
      if (typeof v === 'boolean') return v;
      if (typeof v === 'string') return v === 'true' || v === '1';
      return undefined;
    }, z.boolean().optional()),
});

const checkQuerySchema = z.object({
  tool: z.string().min(1).max(200),
});

export default async function agentPoliciesRoutes(fastify: FastifyInstance) {
  // ────────────────────────────────────────────────────────────────────
  // GET /v1/agent-policies/:agent_user_id
  // ────────────────────────────────────────────────────────────────────
  fastify.get<{ Params: { agent_user_id: string } }>(
    '/v1/agent-policies/:agent_user_id',
    { preHandler: [requireAuth, requireScope('read'), shadowOnly('bam.agent_policy.get')] },
    async (request, reply) => {
      const policy = await getPolicy(request.params.agent_user_id);
      if (!policy) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Agent policy not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      // Org-scope: don't disclose policies across orgs.
      if (policy.org_id !== request.user!.active_org_id) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Agent policy not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.send({
        data: {
          agent_user_id: policy.agent_user_id,
          org_id: policy.org_id,
          enabled: policy.enabled,
          allowed_tools: policy.allowed_tools,
          channel_subscriptions: policy.channel_subscriptions,
          rate_limit_override: policy.rate_limit_override,
          notes: policy.notes,
          updated_at: policy.updated_at.toISOString(),
          updated_by: policy.updated_by,
          updated_by_user: policy.updated_by_user,
        },
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /v1/agent-policies/:agent_user_id (upsert)
  // ────────────────────────────────────────────────────────────────────
  fastify.post<{ Params: { agent_user_id: string } }>(
    '/v1/agent-policies/:agent_user_id',
    { preHandler: [requireAuth, requireScope('read_write'), shadowOnly('bam.agent_policy.create')] },
    async (request, reply) => {
      const parsed = patchSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid agent-policy patch',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }

      const user = request.user!;
      const redis = (fastify as unknown as { redis?: import('ioredis').Redis }).redis ?? null;
      const result = await setPolicy(
        request.params.agent_user_id,
        parsed.data,
        { id: user.id, org_id: user.active_org_id },
        redis,
      );

      if ('error' in result) {
        if (result.error === 'NOT_AN_AGENT') {
          return reply.status(400).send({
            error: {
              code: 'NOT_AN_AGENT',
              message: 'Target user is not an agent or service account',
              details: [],
              request_id: request.id,
            },
          });
        }
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Target user belongs to a different organization',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({
        data: {
          agent_user_id: result.agent_user_id,
          org_id: result.org_id,
          enabled: result.enabled,
          allowed_tools: result.allowed_tools,
          channel_subscriptions: result.channel_subscriptions,
          rate_limit_override: result.rate_limit_override,
          notes: result.notes,
          updated_at: result.updated_at.toISOString(),
          updated_by: result.updated_by,
          updated_by_user: result.updated_by_user,
        },
        confirmation_required: result.confirmation_required,
      });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // GET /v1/agent-policies
  // ────────────────────────────────────────────────────────────────────
  fastify.get(
    '/v1/agent-policies',
    { preHandler: [requireAuth, requireScope('read'), shadowOnly('bam.agent_policy.list')] },
    async (request, reply) => {
      const parsed = listQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid agent-policy list query',
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }

      const callerOrg = request.user!.active_org_id;
      // Only SuperUsers may list policies for a different org; everyone else
      // gets their caller-scoped org regardless of query.
      const orgId =
        parsed.data.org_id && request.user!.is_superuser
          ? parsed.data.org_id
          : callerOrg;

      const rows = await listPolicies(orgId, {
        enabled_only: parsed.data.enabled_only,
      });
      return reply.send({ data: rows });
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /v1/agent-policies/:agent_user_id/check?tool=<name>
  // ────────────────────────────────────────────────────────────────────
  fastify.post<{
    Params: { agent_user_id: string };
    Querystring: { tool?: string };
  }>(
    '/v1/agent-policies/:agent_user_id/check',
    { preHandler: [requireAuth, requireScope('read'), shadowOnly('bam.agent_policy_check.create')] },
    async (request, reply) => {
      const parsed = checkQuerySchema.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: "Query param 'tool' is required",
            details: parsed.error.issues.map((i) => ({
              field: i.path.join('.'),
              issue: i.message,
            })),
            request_id: request.id,
          },
        });
      }
      const decision = await checkPolicy(
        request.params.agent_user_id,
        parsed.data.tool,
      );
      return reply.send({ data: decision });
    },
  );
}
