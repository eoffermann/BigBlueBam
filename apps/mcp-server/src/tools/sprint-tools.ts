import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { handleScopeError } from '../middleware/scope-check.js';
import { registerTool } from '../lib/register-tool.js';

const sprintShape = z.object({
  id: z.string().uuid(),
  name: z.string(),
  project_id: z.string().uuid(),
  status: z.enum(['planned', 'active', 'completed', 'cancelled']),
  start_date: z.string().nullable().optional(),
  end_date: z.string().nullable().optional(),
  goal: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

export function registerSprintTools(server: McpServer, api: ApiClient): void {
  registerTool(server, {
    name: 'list_sprints',
    description: 'List all sprints for a project',
    input: {
      project_id: z.string().uuid().describe('The project ID'),
      status: z.enum(['planned', 'active', 'completed', 'cancelled']).optional().describe('Filter by status'),
    },
    returns: z.object({ data: z.array(sprintShape), next_cursor: z.string().nullable().optional() }),
    handler: async ({ project_id, status }) => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);

      const qs = params.toString();
      const result = await api.get(`/projects/${project_id}/sprints${qs ? `?${qs}` : ''}`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error listing sprints: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'create_sprint',
    description: 'Create a new sprint for a project',
    input: {
      project_id: z.string().uuid().describe('The project ID'),
      name: z.string().max(100).describe('Sprint name'),
      start_date: z.string().describe('Start date (ISO 8601)'),
      end_date: z.string().describe('End date (ISO 8601)'),
      goal: z.string().optional().describe('Sprint goal'),
    },
    returns: sprintShape,
    handler: async ({ project_id, ...sprintData }) => {
      const result = await api.post(`/projects/${project_id}/sprints`, sprintData);

      if (!result.ok) {
        const scopeErr = handleScopeError('create_sprint', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error creating sprint: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'start_sprint',
    description: 'Start a planned sprint',
    input: {
      sprint_id: z.string().uuid().describe('The sprint ID'),
    },
    returns: sprintShape,
    handler: async ({ sprint_id }) => {
      const result = await api.post(`/sprints/${sprint_id}/start`, {});

      if (!result.ok) {
        const scopeErr = handleScopeError('start_sprint', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error starting sprint: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'complete_sprint',
    description: 'Complete an active sprint',
    input: {
      sprint_id: z.string().uuid().describe('The sprint ID'),
      carry_forward: z.object({
        target_sprint_id: z.string().uuid().describe('Sprint to carry incomplete tasks to'),
        tasks: z.array(z.object({
          task_id: z.string().uuid(),
          action: z.enum(['carry_forward', 'backlog', 'cancel']),
        })).describe('Actions for incomplete tasks'),
      }).describe('How to handle incomplete tasks'),
      retrospective_notes: z.string().optional().describe('Retro notes'),
    },
    returns: z.object({ sprint: sprintShape, carried_forward: z.number().optional(), moved_to_backlog: z.number().optional() }).passthrough(),
    handler: async ({ sprint_id, ...body }) => {
      const result = await api.post(`/sprints/${sprint_id}/complete`, body);

      if (!result.ok) {
        const scopeErr = handleScopeError('complete_sprint', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error completing sprint: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'get_sprint',
    description: 'Get a single sprint by UUID, including its status, dates, goal, and (after completion) velocity.',
    input: {
      sprint_id: z.string().uuid().describe('The sprint UUID'),
    },
    returns: z.object({ data: sprintShape }),
    handler: async ({ sprint_id }) => {
      const result = await api.get(`/sprints/${sprint_id}`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error getting sprint: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'update_sprint',
    description: 'Update a sprint\'s name, goal, or start/end dates. Only the supplied fields are changed. Does not change sprint status (use start_sprint / complete_sprint / cancel_sprint for that).',
    input: {
      sprint_id: z.string().uuid().describe('The sprint UUID'),
      name: z.string().max(100).optional().describe('New sprint name'),
      goal: z.string().optional().describe('New sprint goal'),
      start_date: z.string().optional().describe('New start date (ISO 8601)'),
      end_date: z.string().optional().describe('New end date (ISO 8601)'),
    },
    returns: z.object({ data: sprintShape }),
    handler: async ({ sprint_id, ...updates }) => {
      const result = await api.patch(`/sprints/${sprint_id}`, updates);

      if (!result.ok) {
        const scopeErr = handleScopeError('update_sprint', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error updating sprint: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'cancel_sprint',
    description: 'Cancel a planned or active sprint. All tasks in the sprint are returned to the backlog (sprint_id set to null) and the sprint is marked cancelled. Rejects with INVALID_STATE if the sprint is already completed or cancelled.',
    input: {
      sprint_id: z.string().uuid().describe('The sprint UUID'),
    },
    returns: z.object({ data: sprintShape }),
    handler: async ({ sprint_id }) => {
      const result = await api.post(`/sprints/${sprint_id}/cancel`, {});

      if (!result.ok) {
        const scopeErr = handleScopeError('cancel_sprint', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error cancelling sprint: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'get_sprint_report',
    description: 'Get a sprint report with velocity, completion stats, and burndown data',
    input: {
      sprint_id: z.string().uuid().describe('The sprint ID'),
    },
    returns: z.object({
      sprint_id: z.string().uuid(),
      velocity: z.number().optional(),
      total_points: z.number().optional(),
      completed_points: z.number().optional(),
      completion_rate: z.number().optional(),
    }).passthrough(),
    handler: async ({ sprint_id }) => {
      const result = await api.get(`/sprints/${sprint_id}/report`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error getting sprint report: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });
}
