import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { registerTool } from '../lib/register-tool.js';

/**
 * Agent-policy MCP tools (AGENTIC_TODO §15, Wave 5).
 *
 * Tools:
 *   - agent_policy_get   GET    /v1/agent-policies/:agent_user_id
 *   - agent_policy_set   POST   /v1/agent-policies/:agent_user_id    (upsert)
 *   - agent_policy_list  GET    /v1/agent-policies?org_id&enabled_only
 *
 * These wrap the per-agent kill-switch + allowlist table so operators can
 * inspect and adjust policy from the MCP surface without hitting the REST
 * routes directly. The policy-check middleware (register-tool.ts) enforces
 * allowed_tools on every service-account tool invocation.
 *
 * agent_policy_set returns `confirmation_required: true` when the write
 * would flip an already-enabled policy to `enabled: false`; the caller is
 * expected to route through `confirm_action` before committing the kill.
 * The service row is already updated when that flag is returned - the flag
 * is an advisory signal, not a transactional gate. The authoritative
 * two-step confirmation lives at the UI layer; agents driving this tool
 * through an LLM chain should fetch the token, re-call agent_policy_set
 * with an explicit override, and have a human approve in between.
 */

export function registerAgentPolicyTools(server: McpServer, api: ApiClient): void {
  registerTool(server, {
    name: 'agent_policy_get',
    description:
      "Fetch the policy row for a specific agent/service user in the caller's active org. Returns enabled flag, allowed_tools glob list, channel_subscriptions, rate_limit_override, notes, and an updated_by_user join so the caller can see who last touched it. 404 if the user is not in the caller's org or has no policy row yet.",
    input: {
      agent_user_id: z
        .string()
        .uuid()
        .describe("Target agent/service user id. Must be in the caller's active org."),
    },
    returns: z.object({
      data: z
        .object({
          agent_user_id: z.string().uuid(),
          org_id: z.string().uuid(),
          enabled: z.boolean(),
          allowed_tools: z.array(z.string()),
          channel_subscriptions: z.array(z.string().uuid()),
          rate_limit_override: z.number().int().nullable(),
          notes: z.string().nullable(),
          updated_at: z.string(),
          updated_by: z.string().uuid(),
          updated_by_user: z
            .object({ id: z.string().uuid(), name: z.string() })
            .nullable(),
        })
        .passthrough(),
    }),
    handler: async ({ agent_user_id }) => {
      const result = await api.get(`/v1/agent-policies/${agent_user_id}`);
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error fetching agent policy: ${JSON.stringify(result.data)}`,
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
    name: 'agent_policy_set',
    description:
      "Upsert the policy row for an agent/service user. Patch any subset of enabled, allowed_tools, channel_subscriptions, rate_limit_override, notes. allowed_tools uses glob-prefix matching: a single entry '*' allows every tool; entries like 'banter.*' or 'banter_*' allow any tool starting with the prefix; bare entries are exact match. Returns confirmation_required:true when the call flips enabled from true to false on a live agent - the caller is expected to route through confirm_action before committing the kill. 400 if the target is not an agent/service user; 403 if the target is in a different org.",
    input: {
      agent_user_id: z
        .string()
        .uuid()
        .describe("Target agent/service user id. Must be in the caller's active org."),
      patch: z
        .object({
          enabled: z.boolean().optional(),
          allowed_tools: z
            .array(z.string().min(1).max(200))
            .max(512)
            .optional()
            .describe(
              "Glob-prefix allowlist. Use ['*'] for unrestricted access, or e.g. ['banter_*','bond_get_*'] to scope the agent.",
            ),
          channel_subscriptions: z.array(z.string().uuid()).max(512).optional(),
          rate_limit_override: z.number().int().positive().nullable().optional(),
          notes: z.string().max(4000).nullable().optional(),
        })
        .describe('Fields to apply. Omit a field to leave it unchanged.'),
    },
    returns: z.object({
      data: z
        .object({
          agent_user_id: z.string().uuid(),
          org_id: z.string().uuid(),
          enabled: z.boolean(),
          allowed_tools: z.array(z.string()),
          channel_subscriptions: z.array(z.string().uuid()),
          rate_limit_override: z.number().int().nullable(),
          notes: z.string().nullable(),
          updated_at: z.string(),
          updated_by: z.string().uuid(),
          updated_by_user: z
            .object({ id: z.string().uuid(), name: z.string() })
            .nullable(),
        })
        .passthrough(),
      confirmation_required: z.boolean(),
    }),
    handler: async ({ agent_user_id, patch }) => {
      const result = await api.post(
        `/v1/agent-policies/${agent_user_id}`,
        patch ?? {},
      );
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error updating agent policy: ${JSON.stringify(result.data)}`,
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
    name: 'agent_policy_list',
    description:
      "List agent/service policy rows in the caller's active org (SuperUsers may pass org_id to list a different org). Each row carries agent_user_id, agent_name (from users.display_name), enabled flag, allowed_tool_count, last_heartbeat_at from agent_runners (null if the agent has never heartbeat), and updated_at. Use enabled_only=true to restrict to currently-enabled rows.",
    input: {
      org_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          "Only honored for SuperUser callers; everyone else gets their own active org regardless of this hint.",
        ),
      enabled_only: z
        .boolean()
        .optional()
        .describe("If true, restrict to currently-enabled policies."),
    },
    returns: z.object({
      data: z.array(
        z
          .object({
            agent_user_id: z.string().uuid(),
            agent_name: z.string(),
            enabled: z.boolean(),
            allowed_tool_count: z.number().int().nonnegative(),
            last_heartbeat_at: z.string().nullable(),
            updated_at: z.string(),
          })
          .passthrough(),
      ),
    }),
    handler: async ({ org_id, enabled_only }) => {
      const params = new URLSearchParams();
      if (org_id) params.set('org_id', org_id);
      if (enabled_only !== undefined) params.set('enabled_only', String(enabled_only));
      const qs = params.toString();
      const result = await api.get(`/v1/agent-policies${qs ? `?${qs}` : ''}`);
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error listing agent policies: ${JSON.stringify(result.data)}`,
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
