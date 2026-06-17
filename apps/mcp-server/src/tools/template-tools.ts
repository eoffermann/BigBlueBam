import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { handleScopeError } from '../middleware/scope-check.js';
import { resolveProjectId, resolveTemplateId } from './task-tools.js';
import { registerTool } from '../lib/register-tool.js';

const templateShape = z.object({
  id: z.string().uuid(),
  name: z.string(),
  project_id: z.string().uuid(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

function err(label: string, data: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error ${label}: ${JSON.stringify(data)}` }],
    isError: true as const,
  };
}

export function registerTemplateTools(server: McpServer, api: ApiClient): void {
  registerTool(server, {
    name: 'list_templates',
    description: 'List available task templates for a project. Accepts project name or UUID.',
    input: {
      project_id: z.string().describe('Project name or UUID'),
    },
    returns: z.object({ data: z.array(templateShape) }),
    handler: async ({ project_id }) => {
      const resolvedProjectId = await resolveProjectId(api, project_id);
      if (!resolvedProjectId) {
        return err(
          'listing templates',
          `Project '${project_id}' could not be resolved by name or UUID`,
        );
      }

      const result = await api.get(`/projects/${resolvedProjectId}/task-templates`);

      if (!result.ok) {
        return err('listing templates', result.data);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'create_from_template',
    description: 'Create a task from a template, optionally overriding specific fields. Accepts project name and template name in addition to UUIDs.',
    input: {
      project_id: z.string().describe('Project name or UUID'),
      template_id: z
        .string()
        .describe('Template name (scoped to the project) or UUID'),
      overrides: z
        .record(z.unknown())
        .optional()
        .describe(
          'Field overrides to apply on top of the template (e.g. { title, assignee_id, priority }). ' +
            'Sub-keys inside overrides must still be UUIDs.',
        ),
    },
    returns: z.object({
      id: z.string().uuid(),
      human_id: z.string(),
      title: z.string(),
      project_id: z.string().uuid(),
    }).passthrough(),
    handler: async ({ project_id, template_id, overrides }) => {
      const resolvedProjectId = await resolveProjectId(api, project_id);
      if (!resolvedProjectId) {
        return err(
          'creating from template',
          `Project '${project_id}' could not be resolved by name or UUID`,
        );
      }

      const resolvedTemplateId = await resolveTemplateId(
        api,
        resolvedProjectId,
        template_id,
      );
      if (!resolvedTemplateId) {
        return err(
          'creating from template',
          `Template '${template_id}' could not be resolved in project '${project_id}'`,
        );
      }

      const result = await api.post(
        `/projects/${resolvedProjectId}/task-templates/${resolvedTemplateId}/apply`,
        { overrides: overrides ?? {} },
      );

      if (!result.ok) {
        return err('creating from template', result.data);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'create_template',
    description:
      'Create a reusable task template in a project. A template captures a title pattern, default description/priority/story points, labels, a default phase, and an ordered list of subtask titles that are auto-generated when the template is applied (via create_from_template). Accepts a project name or UUID.',
    input: {
      project_id: z.string().describe('Project name or UUID'),
      name: z.string().min(1).max(255).describe('Template name (how it appears in the picker)'),
      title_pattern: z
        .string()
        .max(500)
        .optional()
        .describe('Title applied to the created task (falls back to the template name)'),
      description: z.string().optional().describe('Default task description (markdown)'),
      priority: z
        .enum(['critical', 'high', 'medium', 'low'])
        .optional()
        .describe("Default priority (defaults to 'medium')"),
      labels: z.array(z.string().uuid()).optional().describe('Label UUIDs attached to created tasks'),
      phase_id: z.string().uuid().optional().describe('Default phase UUID for created tasks'),
      subtasks: z
        .array(z.string())
        .optional()
        .describe('Ordered subtask titles auto-created when the template is applied'),
      story_points: z.number().int().positive().optional().describe('Default story-point estimate'),
    },
    returns: z.object({ data: templateShape }),
    handler: async ({ project_id, ...rest }) => {
      const resolvedProjectId = await resolveProjectId(api, project_id);
      if (!resolvedProjectId) {
        return err(
          'creating template',
          `Project '${project_id}' could not be resolved by name or UUID`,
        );
      }

      const result = await api.post(`/projects/${resolvedProjectId}/task-templates`, rest);

      if (!result.ok) {
        const scopeErr = handleScopeError('create_template', 'read_write', result);
        if (scopeErr) return scopeErr;
        return err('creating template', result.data);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'delete_template',
    description:
      'Delete a task template by UUID (destructive). Tasks previously created from it are unaffected. Requires confirm:true — the first call without it returns a confirmation prompt and changes nothing.',
    input: {
      template_id: z.string().uuid().describe('The task-template UUID to delete'),
      confirm: z.boolean().describe('Must be true to confirm deletion'),
    },
    returns: z.object({ data: z.object({ success: z.boolean() }) }),
    handler: async ({ template_id, confirm }) => {
      if (!confirm) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Are you sure you want to delete template ${template_id}? Call this tool again with confirm: true to proceed.`,
            },
          ],
        };
      }

      const result = await api.delete(`/task-templates/${template_id}`);

      if (!result.ok) {
        const scopeErr = handleScopeError('delete_template', 'read_write', result);
        if (scopeErr) return scopeErr;
        return err('deleting template', result.data);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });
}
