import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { registerTool } from '../lib/register-tool.js';

/**
 * Durable agent-proposal MCP tools (AGENTIC_TODO §9, Wave 2).
 *
 * Tools:
 *   - proposal_create    POST /v1/proposals
 *   - proposal_list      GET  /v1/proposals
 *   - proposal_decide    POST /v1/proposals/:id/decide
 *
 * These wrap the new durable-proposal surface. Agents should migrate from
 * the fire-and-forget /v1/approvals event producer (wrapped implicitly by
 * Bolt rules) to these tools when they need a human to see the proposal in
 * a persistent inbox and respond with an explicit decision.
 */
export function registerProposalTools(server: McpServer, api: ApiClient): void {
  registerTool(server, {
    name: 'proposal_create',
    description:
      "Create a durable proposal in the agent_proposals queue. The proposal shows up in the approver's inbox and remains actionable until decided or expired. Use this for destructive or human-gated actions where you need an explicit approval on record (not just a DM notification).",
    input: {
      proposed_action: z
        .string()
        .min(1)
        .max(200)
        .describe("Short identifier for the action (e.g. 'blast.campaign.send', 'bond.deal.close')."),
      proposed_payload: z
        .record(z.unknown())
        .optional()
        .describe('Optional structured payload describing the action (used by downstream automation on approval).'),
      approver_id: z
        .string()
        .uuid()
        .describe('User id of the approver.'),
      subject_type: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('Optional free-form identifier linking the proposal to a subject entity type (e.g. "blast.campaign").'),
      subject_id: z
        .string()
        .uuid()
        .optional()
        .describe('Optional subject entity UUID.'),
      ttl_seconds: z
        .number()
        .int()
        .positive()
        .max(2_592_000)
        .optional()
        .describe('Expiry window in seconds (default 604800=7d, max 2592000=30d).'),
      decision_reason: z
        .string()
        .max(4000)
        .optional()
        .describe('Optional initial context for the approver.'),
      require_human_decider: z
        .boolean()
        .optional()
        .describe('When true, only a human signed in as themselves (not an agent, service account, or impersonated session) can decide.'),
    },
    returns: z
      .object({
        data: z
          .object({
            id: z.string().uuid(),
            org_id: z.string().uuid(),
            actor_id: z.string().uuid(),
            proposer_kind: z.string(),
            proposed_action: z.string(),
            approver_id: z.string().uuid().nullable().optional(),
            status: z.string(),
            expires_at: z.string(),
            created_at: z.string(),
          })
          .passthrough(),
      })
      .passthrough(),
    handler: async (body) => {
      const result = await api.post('/v1/proposals', body);
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error creating proposal: ${JSON.stringify(result.data)}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'proposal_list',
    description:
      "List proposals visible to the caller. By default returns pending proposals where the caller is either the approver or the actor; org admins see the whole org queue. Pass filter[status]=all to see decided rows too.",
    input: {
      approver_id: z
        .string()
        .uuid()
        .optional()
        .describe('Filter to proposals assigned to this approver.'),
      actor_id: z
        .string()
        .uuid()
        .optional()
        .describe('Filter to proposals authored by this actor.'),
      status: z
        .enum(['pending', 'approved', 'rejected', 'expired', 'revoked', 'revising', 'all'])
        .optional()
        .describe("Status filter (default 'pending'). Pass 'all' to remove the status filter."),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe('Page size (default 50, max 200).'),
      cursor: z
        .string()
        .optional()
        .describe('Pagination cursor (ISO-8601 created_at of the last row on the prior page).'),
    },
    returns: z.object({
      data: z.array(
        z
          .object({
            id: z.string().uuid(),
            status: z.string(),
            proposed_action: z.string(),
            approver_id: z.string().uuid().nullable().optional(),
            actor_id: z.string().uuid(),
            created_at: z.string(),
            expires_at: z.string(),
            // Issue #128: who actually decided and how.
            decided_at: z.string().nullable().optional(),
            decided_by: z.string().uuid().nullable().optional(),
            decided_by_kind: z.enum(['human', 'agent', 'service']).nullable().optional(),
            decided_impersonator_id: z.string().uuid().nullable().optional(),
            owning_app: z.string().nullable().optional(),
            require_human_decider: z.boolean().optional(),
          })
          .passthrough(),
      ),
      meta: z
        .object({
          next_cursor: z.string().nullable().optional(),
          has_more: z.boolean().optional(),
        })
        .passthrough(),
    }),
    handler: async ({ approver_id, actor_id, status, limit, cursor }) => {
      const params = new URLSearchParams();
      if (approver_id) params.set('filter[approver_id]', approver_id);
      if (actor_id) params.set('filter[actor_id]', actor_id);
      if (status) params.set('filter[status]', status);
      if (limit !== undefined) params.set('limit', String(limit));
      if (cursor) params.set('cursor', cursor);
      const qs = params.toString();
      const result = await api.get(`/v1/proposals${qs ? `?${qs}` : ''}`);
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error listing proposals: ${JSON.stringify(result.data)}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'proposal_decide',
    description:
      "Decide a pending or revising proposal. Only the designated approver (or an org admin) may decide. The decider, their kind (human/agent/service) and any impersonating SuperUser are recorded. Returns 409 PROPOSAL_ALREADY_DECIDED if it was already decided, 409 DECIDE_IN_APP if the proposal belongs to an app (owning_app) and must be decided there, 410 if it expired, 403 if the caller is not authorized, and 403 HUMAN_DECIDER_REQUIRED when the proposal requires a human decider and the caller is an agent, a service account, or an impersonated session.",
    input: {
      proposal_id: z.string().uuid().describe('Proposal id to decide.'),
      decision: z
        .enum(['approve', 'reject', 'request_revision'])
        .describe("Decision to apply. 'request_revision' moves the proposal to 'revising' and it remains decidable."),
      reason: z.string().max(4000).optional().describe('Optional justification for the decision.'),
    },
    returns: z
      .object({
        data: z
          .object({
            id: z.string().uuid(),
            status: z.string(),
            decided_at: z.string().nullable().optional(),
            decision_reason: z.string().nullable().optional(),
            decided_by: z.string().uuid().nullable().optional(),
            decided_by_kind: z.enum(['human', 'agent', 'service']).nullable().optional(),
            decided_impersonator_id: z.string().uuid().nullable().optional(),
          })
          .passthrough(),
      })
      .passthrough(),
    handler: async ({ proposal_id, decision, reason }) => {
      const body: Record<string, unknown> = { decision };
      if (reason !== undefined) body.reason = reason;
      const result = await api.post(`/v1/proposals/${proposal_id}/decide`, body);
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error deciding proposal: ${JSON.stringify(result.data)}`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });
}
