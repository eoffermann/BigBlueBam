import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { registerTool } from '../lib/register-tool.js';

/**
 * Agent identity / audit / heartbeat MCP tools (AGENTIC_TODO §10, Wave 1).
 *
 * Tools:
 *   - agent_heartbeat      service-account only. Upserts agent_runners row.
 *   - agent_audit          any authed user. Lists activity_log for a given agent.
 *   - agent_self_report    service-account only. Appends activity_log entry.
 *   - agent_list           any authed user. Lists agent_runners in the active org.
 *
 * The "service-account only" gate is enforced at the API layer via
 * `request.user.kind === 'service'`; if a non-service caller invokes these
 * tools the MCP server will receive a 403 NOT_A_SERVICE_ACCOUNT from the
 * wrapped endpoint and surface it through the standard error shape.
 */
export function registerAgentTools(server: McpServer, api: ApiClient): void {
  registerTool(server, {
    name: 'agent_heartbeat',
    description:
      'Service-account only. Register or refresh the calling runner in agent_runners. Upserts by the service-account user id; bumps last_heartbeat_at and merges name/version/capabilities. Callers that are not service accounts get 403 NOT_A_SERVICE_ACCOUNT.',
    input: {
      runner_name: z
        .string()
        .min(1)
        .max(200)
        .describe("Human-readable runner name, e.g. 'banter-listener' or 'intake-worker'."),
      version: z
        .string()
        .max(100)
        .optional()
        .describe('Runner build version string (semver or git sha). Optional.'),
      capabilities: z
        .array(z.string().min(1).max(200))
        .max(256)
        .optional()
        .describe(
          "Free-form capability tags, e.g. ['banter.subscribe', 'helpdesk.triage']. Shape is flexible in Wave 1; a canonical registry is Wave 2 work.",
        ),
    },
    returns: z
      .object({
        data: z
          .object({
            id: z.string().uuid(),
            org_id: z.string().uuid(),
            user_id: z.string().uuid(),
            name: z.string(),
            version: z.string().nullable().optional(),
            capabilities: z.array(z.unknown()).optional(),
            last_heartbeat_at: z.string().nullable().optional(),
            first_seen_at: z.string().optional(),
          })
          .passthrough(),
      })
      .passthrough(),
    handler: async ({ runner_name, version, capabilities }) => {
      const body: Record<string, unknown> = { runner_name };
      if (version !== undefined) body.version = version;
      if (capabilities !== undefined) body.capabilities = capabilities;
      const result = await api.post('/v1/agents/heartbeat', body);
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error recording heartbeat: ${JSON.stringify(result.data)}`,
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
    name: 'agent_audit',
    description:
      "Fetch the activity_log stream for a specific agent (service-account user) in the caller's active org. Paginated by created_at cursor. Wave 1 covers activity_log only; bond/helpdesk/banter audit merges are Wave 2.",
    input: {
      agent_user_id: z
        .string()
        .uuid()
        .describe('User id of the service account to audit. Must be in the caller\'s active org.'),
      since: z
        .string()
        .optional()
        .describe('ISO-8601 timestamp; only return rows created at or after this time.'),
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
            project_id: z.string().uuid(),
            actor_id: z.string().uuid(),
            actor_type: z.string().optional(),
            action: z.string(),
            created_at: z.string(),
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
    handler: async ({ agent_user_id, since, limit, cursor }) => {
      const params = new URLSearchParams();
      if (since) params.set('since', since);
      if (limit !== undefined) params.set('limit', String(limit));
      if (cursor) params.set('cursor', cursor);
      const qs = params.toString();
      const result = await api.get(
        `/v1/agents/${agent_user_id}/audit${qs ? `?${qs}` : ''}`,
      );
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error fetching agent audit: ${JSON.stringify(result.data)}`,
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
    name: 'agent_self_report',
    description:
      "Service-account only. Append a self-report entry (action='agent.self_report') to activity_log under the given project. project_id is REQUIRED — the platform does not create sentinel projects in Wave 1. Callers that are not service accounts get 403 NOT_A_SERVICE_ACCOUNT.",
    input: {
      summary: z
        .string()
        .min(1)
        .max(4000)
        .describe('Short free-text description of the run (goals, outcomes, errors).'),
      metrics: z
        .record(z.unknown())
        .optional()
        .describe('Optional structured metrics JSON (counts, durations, etc).'),
      project_id: z
        .string()
        .uuid()
        .describe('Project to scope the self-report under. Required.'),
    },
    returns: z
      .object({
        data: z
          .object({
            id: z.string().uuid(),
            project_id: z.string().uuid(),
            actor_id: z.string().uuid(),
            actor_type: z.string().optional(),
            action: z.string(),
            created_at: z.string(),
          })
          .passthrough(),
      })
      .passthrough(),
    handler: async ({ summary, metrics, project_id }) => {
      const body: Record<string, unknown> = { summary, project_id };
      if (metrics !== undefined) body.metrics = metrics;
      const result = await api.post('/v1/agents/self-report', body);
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error recording agent self-report: ${JSON.stringify(result.data)}`,
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
    name: 'agent_list',
    description:
      "List the agent runners registered in the caller's active org. Returns one row per service-account user that has ever heartbeat'd, sorted by last_heartbeat_at descending (rows that have never heartbeat'd sort last). Use this to discover which agents exist, their advertised capabilities, version strings, and liveness (a NULL last_heartbeat_at means registered-but-never-seen; a stale timestamp means the runner has gone quiet). Any authenticated user may call this; no service-account gate.",
    input: {},
    returns: z.object({
      data: z.array(
        z
          .object({
            id: z.string().uuid(),
            org_id: z.string().uuid(),
            user_id: z.string().uuid(),
            name: z.string(),
            version: z.string().nullable().optional(),
            capabilities: z.array(z.unknown()).optional(),
            last_heartbeat_at: z.string().nullable().optional(),
            first_seen_at: z.string().optional(),
            created_at: z.string().optional(),
            updated_at: z.string().optional(),
          })
          .passthrough(),
      ),
    }),
    handler: async () => {
      const result = await api.get('/v1/agents');
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error listing agents: ${JSON.stringify(result.data)}`,
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
