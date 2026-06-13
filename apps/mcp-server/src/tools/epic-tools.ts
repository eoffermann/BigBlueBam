import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { handleScopeError } from '../middleware/scope-check.js';
import { registerTool } from '../lib/register-tool.js';

/**
 * Bam epic write/detail tools (Epics Part 2, E1–E4).
 *
 * `bam_list_epics` already lives in bam-resolver-tools.ts and stays there;
 * these three are the create / update / detail half. They call the Bam REST
 * API the same way the other bam_* tools do (via the shared ApiClient) and
 * return the standard `{ data: … }` envelope.
 *
 * Idempotency note for importers: `bam_list_epics` + `bam_create_epic` are
 * the canonical pair — list the project's epics, match by name, and only
 * call `bam_create_epic` when no existing epic matches.
 */

const epicStatus = z
  .enum(['open', 'in_progress', 'closed'])
  .describe("Epic status: 'open', 'in_progress', or 'closed'");

const epicShape = z
  .object({
    id: z.string().uuid(),
    project_id: z.string().uuid(),
    name: z.string(),
    description: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
    start_date: z.string().nullable().optional(),
    target_date: z.string().nullable().optional(),
    status: z.string(),
    task_count: z.number().optional(),
    done_count: z.number().optional(),
    total_story_points: z.number().optional(),
    done_story_points: z.number().optional(),
    created_at: z.string(),
    updated_at: z.string(),
  })
  .passthrough();

function err(label: string, data: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error ${label}: ${JSON.stringify(data)}` }],
    isError: true as const,
  };
}

export function registerEpicTools(server: McpServer, api: ApiClient): void {
  registerTool(server, {
    name: 'bam_create_epic',
    description:
      'Create a new epic in a project. Idempotency pair with bam_list_epics: list the project\'s epics first, match by name, and only call this when no existing epic matches (list, then create if absent).',
    input: {
      project_id: z.string().uuid().describe('The project UUID'),
      name: z.string().min(1).max(500).describe('Epic name'),
      description: z.string().nullable().optional().describe('Epic description (markdown)'),
      color: z
        .string()
        .nullable()
        .optional()
        .describe('Hex color for the epic chip (e.g. #4F46E5)'),
      start_date: z.string().nullable().optional().describe('Start date (ISO 8601 / YYYY-MM-DD)'),
      target_date: z.string().nullable().optional().describe('Target date (ISO 8601 / YYYY-MM-DD)'),
      status: epicStatus.optional(),
    },
    returns: z.object({ data: epicShape }),
    handler: async ({ project_id, ...rest }) => {
      const result = await api.post(`/projects/${project_id}/epics`, rest);
      if (!result.ok) {
        const scopeErr = handleScopeError('bam_create_epic', 'read_write', result);
        if (scopeErr) return scopeErr;
        return err('creating epic', result.data);
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'bam_update_epic',
    description:
      'Update an existing epic. Only the supplied fields are changed. Use this to rename, recolor, reschedule, or change the status of an epic (set status to "closed" to close it).',
    input: {
      epic_id: z.string().uuid().describe('The epic UUID'),
      name: z.string().min(1).max(500).optional().describe('New epic name'),
      description: z.string().nullable().optional().describe('New description (markdown)'),
      color: z.string().nullable().optional().describe('New hex color (e.g. #4F46E5)'),
      start_date: z.string().nullable().optional().describe('New start date (ISO 8601 / YYYY-MM-DD)'),
      target_date: z
        .string()
        .nullable()
        .optional()
        .describe('New target date (ISO 8601 / YYYY-MM-DD)'),
      status: epicStatus.optional(),
    },
    returns: z.object({ data: epicShape }),
    handler: async ({ epic_id, ...rest }) => {
      const result = await api.patch(`/epics/${epic_id}`, rest);
      if (!result.ok) {
        const scopeErr = handleScopeError('bam_update_epic', 'read_write', result);
        if (scopeErr) return scopeErr;
        return err('updating epic', result.data);
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'bam_get_epic',
    description:
      'Get a single epic by UUID, including its rollup (task_count, done_count, total_story_points, done_story_points over all tasks linked to the epic).',
    input: {
      epic_id: z.string().uuid().describe('The epic UUID'),
    },
    returns: z.object({ data: epicShape }),
    handler: async ({ epic_id }) => {
      const result = await api.get(`/epics/${epic_id}`);
      if (!result.ok) {
        return err('getting epic', result.data);
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });
}
