import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { registerTool } from '../lib/register-tool.js';

/**
 * Bam resolver / list tools - Phase C, Tier 2 of the Bolt ID-mapping
 * strategy. These are read-only lookups that let MCP consumers translate
 * human-friendly references (phase name, label name, state category,
 * epic name, etc.) into the canonical UUIDs the mutating Bam tools
 * already require. All tools call the Bam REST API rather than the DB
 * directly, and all handlers match the standard MCP response envelope
 * used by the other tool files in this directory.
 */
export function registerBamResolverTools(server: McpServer, api: ApiClient): void {
  registerTool(server, {
    name: 'bam_list_phases',
    description: 'List all phases (board columns) for a project, ordered by position',
    input: {
      project_id: z.string().uuid().describe('The project ID'),
    },
    returns: z.object({
      data: z.array(z.object({
        id: z.string().uuid(),
        name: z.string(),
        position: z.number().optional(),
        project_id: z.string().uuid().optional(),
      }).passthrough()),
    }),
    handler: async ({ project_id }) => {
      const result = await api.get(`/projects/${project_id}/phases`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error listing phases: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'bam_list_labels',
    description: 'List labels. If project_id is given, lists labels for that project; otherwise lists labels for every project the caller can see in their org.',
    input: {
      project_id: z.string().uuid().optional().describe('Optional project ID to scope results'),
    },
    returns: z.object({
      data: z.array(z.object({
        id: z.string().uuid(),
        name: z.string(),
        color: z.string().nullable().optional(),
        project_id: z.string().uuid().optional(),
      }).passthrough()),
    }),
    handler: async ({ project_id }) => {
      const path = project_id ? `/projects/${project_id}/labels` : '/labels';
      const result = await api.get(path);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error listing labels: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'bam_list_states',
    description: 'List all task states for a project, ordered by position. Each state has a category in { todo, active, blocked, review, done, cancelled }.',
    input: {
      project_id: z.string().uuid().describe('The project ID'),
    },
    returns: z.object({
      data: z.array(z.object({
        id: z.string().uuid(),
        name: z.string(),
        category: z.string(),
        position: z.number().optional(),
        project_id: z.string().uuid().optional(),
      }).passthrough()),
    }),
    handler: async ({ project_id }) => {
      const result = await api.get(`/projects/${project_id}/states`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error listing states: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'bam_list_epics',
    description: 'List all epics for a project, with task counts and status.',
    input: {
      project_id: z.string().uuid().describe('The project ID'),
    },
    returns: z.object({
      data: z.array(z.object({
        id: z.string().uuid(),
        title: z.string(),
        status: z.string().optional(),
        task_count: z.number().optional(),
        project_id: z.string().uuid().optional(),
      }).passthrough()),
    }),
    handler: async ({ project_id }) => {
      const result = await api.get(`/projects/${project_id}/epics`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error listing epics: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });
}
