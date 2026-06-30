import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { registerTool } from '../lib/register-tool.js';

/**
 * Visibility preflight MCP tool (AGENTIC_TODO §11, Wave 2).
 *
 * Tool:
 *   - can_access   any authed caller with read scope. Asks: is this entity
 *                  visible to `asker_user_id`? Returns {allowed, reason}.
 *
 * Agent convention: any agent that posts cross-app results into a shared
 * surface (Banter channel, ticket reply, Brief comment, anywhere else the
 * asker or a different human will see it) MUST call can_access for every
 * cited entity first and filter out non-accessible ones. See
 * docs/agent-conventions.md for the full protocol.
 *
 * The canonical allowlist of entity_type values is enforced by the API
 * route; supplying an unsupported type returns
 * `{ allowed: false, reason: 'unsupported_entity_type' }`. Agents that see
 * that reason MUST err on the side of NOT surfacing the entity.
 */
export function registerVisibilityTools(server: McpServer, api: ApiClient): void {
  registerTool(server, {
    name: 'can_access',
    description:
      "Preflight a visibility check. Returns { allowed, reason } for whether asker_user_id can see (entity_type, entity_id). Agents that surface cross-app results into shared channels MUST call this for every cited entity and filter out anything that is not allowed. Supported entity_type values: bam.task, bam.project, bam.sprint, helpdesk.ticket, bond.deal, bond.contact, bond.company, brief.document, beacon.entry, blueprint.diagram, blueprint.node, banter.message, banter.channel, bearing.goal, bearing.kr, board.board, book.event, bill.invoice, blank.form, bolt.rule, blip.tracked_app, blip.saved_view. Unsupported types return reason='unsupported_entity_type' (with a supported_entity_types hint) and MUST NOT be surfaced.",
    input: {
      asker_user_id: z
        .string()
        .uuid()
        .describe(
          'User id of the human whose visibility should gate the surface (e.g. Banter message author, helpdesk requester).',
        ),
      entity_type: z
        .string()
        .min(1)
        .max(64)
        .describe(
          "Entity kind, e.g. 'bam.task', 'bond.deal', 'beacon.entry'. Only the canonical allowlist is supported; unknown types return reason='unsupported_entity_type'.",
        ),
      entity_id: z
        .string()
        .min(1)
        .max(128)
        .describe('Entity id (UUID for every type in the current allowlist).'),
    },
    returns: z.object({
      data: z
        .object({
          allowed: z.boolean(),
          reason: z.string(),
          entity_org_id: z.string().uuid().optional(),
          supported_entity_types: z.array(z.string()).optional(),
        })
        .passthrough(),
    }),
    handler: async ({ asker_user_id, entity_type, entity_id }) => {
      const result = await api.post('/v1/visibility/can_access', {
        asker_user_id,
        entity_type,
        entity_id,
      });
      if (!result.ok) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error running visibility preflight: ${JSON.stringify(result.data)}`,
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
