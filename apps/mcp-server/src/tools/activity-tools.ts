import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { registerTool } from '../lib/register-tool.js';

/**
 * Unified activity-log MCP tools (AGENTIC_TODO §5, Wave 3).
 *
 * Tools:
 *   - activity_query      GET /v1/activity/unified
 *   - activity_by_actor   GET /v1/activity/unified/by-actor
 *
 * Both wrap the unified view (v_activity_unified, migration 0129) so agents
 * can answer "who last touched X?" and "what has this actor been up to?"
 * across Bam, Bond, and Helpdesk with a single call.
 *
 * actor_type in the returned rows is the platform vocabulary
 * ('human' | 'agent' | 'service'). Helpdesk rows whose raw actor_type
 * was 'agent' (meaning HUMAN support agent) are remapped to 'human'
 * server-side - see the migration 0129 header for the full landmine
 * note. Agents filtering for "AI agent activity" should look for
 * actor_type='agent', not rely on any source_app marker.
 */
export function registerActivityTools(server: McpServer, api: ApiClient): void {
  registerTool(server, {
    name: 'activity_query',
    description:
      "Query the unified activity log for a given entity. Returns rows from Bam activity_log, Bond bond_activities, and Helpdesk ticket_activity_log under a normalized shape. Visibility is gated server-side: you will only see rows your current user/org can access. Paginated by a `<iso-ts>|<uuid>` cursor.",
    input: {
      entity_type: z
        .string()
        .min(1)
        .max(100)
        .describe(
          "Entity type tag (e.g. 'bam.task', 'bam.project', 'bond.deal', 'bond.contact', 'bond.company', 'helpdesk.ticket').",
        ),
      entity_id: z.string().uuid().describe('Entity UUID to fetch history for.'),
      since: z
        .string()
        .optional()
        .describe('ISO-8601 timestamp; only return rows created at or after this time.'),
      cursor: z
        .string()
        .optional()
        .describe(
          'Pagination cursor. Format is `<iso-8601 created_at>|<row uuid>`, returned as `meta.next_cursor` on the previous page.',
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe('Page size (default 50, max 200).'),
    },
    returns: z.object({
      data: z.array(
        z
          .object({
            id: z.string().uuid(),
            source_app: z.enum(['bam', 'bond', 'helpdesk']),
            entity_type: z.string(),
            entity_id: z.string().uuid().nullable().optional(),
            project_id: z.string().uuid().nullable().optional(),
            organization_id: z.string().uuid().nullable().optional(),
            actor_id: z.string().uuid().nullable().optional(),
            actor_type: z.string(),
            action: z.string(),
            details: z.unknown().nullable().optional(),
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
    handler: async ({ entity_type, entity_id, since, cursor, limit }) => {
      const params = new URLSearchParams();
      params.set('entity_type', entity_type);
      params.set('entity_id', entity_id);
      if (since) params.set('since', since);
      if (cursor) params.set('cursor', cursor);
      if (limit !== undefined) params.set('limit', String(limit));
      const result = await api.get(`/v1/activity/unified?${params.toString()}`);
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error querying unified activity: ${JSON.stringify(result.data)}`,
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
    name: 'activity_by_actor',
    description:
      "Query the unified activity log for everything a specific actor (user) has done across Bam, Bond, and Helpdesk. The target actor must share the caller's active org (404 otherwise). Visibility for individual rows is gated server-side.",
    input: {
      actor_id: z
        .string()
        .uuid()
        .describe("User id of the actor. Must be in the caller's active org."),
      since: z
        .string()
        .optional()
        .describe('ISO-8601 timestamp; only return rows created at or after this time.'),
      cursor: z
        .string()
        .optional()
        .describe('Pagination cursor (see `activity_query` for format).'),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe('Page size (default 50, max 200).'),
    },
    returns: z.object({
      data: z.array(
        z
          .object({
            id: z.string().uuid(),
            source_app: z.enum(['bam', 'bond', 'helpdesk']),
            entity_type: z.string(),
            entity_id: z.string().uuid().nullable().optional(),
            project_id: z.string().uuid().nullable().optional(),
            organization_id: z.string().uuid().nullable().optional(),
            actor_id: z.string().uuid().nullable().optional(),
            actor_type: z.string(),
            action: z.string(),
            details: z.unknown().nullable().optional(),
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
    handler: async ({ actor_id, since, cursor, limit }) => {
      const params = new URLSearchParams();
      params.set('actor_id', actor_id);
      if (since) params.set('since', since);
      if (cursor) params.set('cursor', cursor);
      if (limit !== undefined) params.set('limit', String(limit));
      const result = await api.get(
        `/v1/activity/unified/by-actor?${params.toString()}`,
      );
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error querying activity by actor: ${JSON.stringify(result.data)}`,
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
