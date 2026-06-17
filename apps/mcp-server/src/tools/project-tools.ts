import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { handleScopeError } from '../middleware/scope-check.js';
import { registerTool } from '../lib/register-tool.js';

const projectShape = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string().optional(),
  task_id_prefix: z.string(),
  description: z.string().nullable().optional(),
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

export function registerProjectTools(server: McpServer, api: ApiClient): void {
  registerTool(server, {
    name: 'list_projects',
    description: 'List all projects the current user has access to',
    input: {
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(200).optional().describe('Number of results (default 50)'),
    },
    returns: z.object({ data: z.array(projectShape), next_cursor: z.string().nullable().optional() }),
    handler: async ({ cursor, limit }) => {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      if (limit) params.set('limit', String(limit));

      const qs = params.toString();
      const result = await api.get(`/projects${qs ? `?${qs}` : ''}`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error listing projects: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'get_project',
    description: 'Get detailed information about a specific project',
    input: {
      project_id: z.string().uuid().describe('The project ID'),
    },
    returns: projectShape,
    handler: async ({ project_id }) => {
      const result = await api.get(`/projects/${project_id}`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error getting project: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'create_project',
    description: 'Create a new project',
    input: {
      name: z.string().max(255).describe('Project name'),
      task_id_prefix: z.string().regex(/^[A-Z]{2,6}$/).describe('Task ID prefix (2-6 uppercase letters)'),
      description: z.string().optional().describe('Project description'),
      slug: z.string().max(100).regex(/^[a-z0-9-]+$/).optional().describe('URL-friendly slug'),
      icon: z.string().max(10).optional().describe('Emoji icon'),
      color: z.string().optional().describe('Hex color'),
      template: z.enum(['kanban_standard', 'scrum', 'bug_tracking', 'minimal', 'none']).optional().describe('Project template'),
    },
    returns: projectShape,
    handler: async (params) => {
      const result = await api.post('/projects', params);

      if (!result.ok) {
        const scopeErr = handleScopeError('create_project', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error creating project: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'test_slack_webhook',
    description: 'Send a test message to the Slack webhook configured for a project. Requires project admin or org admin role.',
    input: {
      project_id: z.string().uuid().describe('The project ID'),
    },
    returns: z.object({ ok: z.boolean(), message: z.string().optional() }),
    handler: async ({ project_id }) => {
      const result = await api.post(`/projects/${project_id}/slack-integration/test`, {});

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error testing Slack webhook: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'disconnect_github_integration',
    description: 'Remove the GitHub integration from a project. This is destructive — it deletes the webhook config and all linked commit/PR references. Requires project admin or org admin role.',
    input: {
      project_id: z.string().uuid().describe('The project ID'),
      confirm: z.boolean().describe('Must be true to proceed with the destructive action.'),
    },
    returns: z.object({ ok: z.boolean() }),
    handler: async ({ project_id, confirm }) => {
      if (!confirm) {
        return {
          content: [{ type: 'text' as const, text: 'Set confirm=true to proceed with this destructive action.' }],
          isError: true,
        };
      }

      const result = await api.delete(`/projects/${project_id}/github-integration`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error disconnecting GitHub integration: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'update_project',
    description: 'Update a project\'s editable fields (name, description, slug, icon, color, default sprint duration). Only the supplied fields change. Requires project admin (or org owner/admin).',
    input: {
      project_id: z.string().uuid().describe('The project ID'),
      name: z.string().max(255).optional().describe('New project name'),
      description: z.string().optional().describe('New description'),
      slug: z.string().max(100).regex(/^[a-z0-9-]+$/).optional().describe('New URL-friendly slug'),
      icon: z.string().max(10).optional().describe('New emoji icon'),
      color: z.string().optional().describe('New hex color'),
      default_sprint_duration_days: z.number().int().positive().optional().describe('Default sprint length in days'),
    },
    returns: projectShape,
    handler: async ({ project_id, ...updates }) => {
      const result = await api.patch(`/projects/${project_id}`, updates);

      if (!result.ok) {
        const scopeErr = handleScopeError('update_project', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error updating project: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'archive_project',
    description: 'Archive a project (destructive — the project disappears from active lists). Requires project admin (or org owner/admin). Requires confirm:true — the first call without it returns a confirmation prompt and changes nothing.',
    input: {
      project_id: z.string().uuid().describe('The project ID to archive'),
      confirm: z.boolean().describe('Must be true to confirm archiving'),
    },
    returns: projectShape,
    handler: async ({ project_id, confirm }) => {
      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: `Are you sure you want to archive project ${project_id}? Call this tool again with confirm: true to proceed.`,
          }],
        };
      }

      const result = await api.delete(`/projects/${project_id}`);

      if (!result.ok) {
        const scopeErr = handleScopeError('archive_project', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error archiving project: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  // ─── Project members ────────────────────────────────────────────────────
  registerTool(server, {
    name: 'list_project_members',
    description: 'List the members of a project, with their per-project role.',
    input: {
      project_id: z.string().uuid().describe('The project ID'),
    },
    returns: z.object({
      data: z.array(
        z
          .object({
            user_id: z.string().uuid().optional(),
            role: z.string().optional(),
            display_name: z.string().optional(),
          })
          .passthrough(),
      ),
    }),
    handler: async ({ project_id }) => {
      const result = await api.get(`/projects/${project_id}/members`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error listing project members: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'add_project_member',
    description: 'Add an existing org member to a project with the given project role. Requires project admin (or org owner/admin). The user must already belong to the org.',
    input: {
      project_id: z.string().uuid().describe('The project ID'),
      user_id: z.string().uuid().describe('The org member\'s user UUID to add'),
      role: z.enum(['admin', 'member', 'viewer']).describe('Project role to grant'),
    },
    returns: z.object({
      data: z
        .object({ user_id: z.string().uuid().optional(), role: z.string().optional() })
        .passthrough(),
    }),
    handler: async ({ project_id, user_id, role }) => {
      const result = await api.post(`/projects/${project_id}/members`, { user_id, role });

      if (!result.ok) {
        const scopeErr = handleScopeError('add_project_member', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error adding project member: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  // ─── Custom-field definitions ───────────────────────────────────────────
  const customFieldType = z.enum(['text', 'number', 'date', 'select', 'multi_select', 'checkbox', 'url']);
  const customFieldShape = z
    .object({
      id: z.string().uuid(),
      project_id: z.string().uuid(),
      name: z.string(),
      field_type: z.string(),
      options: z.unknown().nullable().optional(),
      is_required: z.boolean().optional(),
      is_visible_on_card: z.boolean().optional(),
      position: z.number().optional(),
    })
    .passthrough();

  registerTool(server, {
    name: 'list_custom_fields',
    description: 'List the custom-field definitions for a project, ordered by display position.',
    input: {
      project_id: z.string().uuid().describe('The project ID'),
    },
    returns: z.object({ data: z.array(customFieldShape) }),
    handler: async ({ project_id }) => {
      const result = await api.get(`/projects/${project_id}/custom-fields`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error listing custom fields: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'create_custom_field',
    description: 'Create a custom-field definition on a project. For select / multi_select types, pass the choices in `options`.',
    input: {
      project_id: z.string().uuid().describe('The project ID'),
      name: z.string().max(255).describe('Field name'),
      field_type: customFieldType.describe('Field type'),
      options: z.unknown().optional().describe('Type-specific options (e.g. choices for select/multi_select)'),
      is_required: z.boolean().optional().describe('Whether the field is required (default false)'),
      is_visible_on_card: z.boolean().optional().describe('Whether to show the field on the board card (default false)'),
      position: z.number().int().optional().describe('Display order (default 0)'),
    },
    returns: z.object({ data: customFieldShape }),
    handler: async ({ project_id, ...rest }) => {
      const result = await api.post(`/projects/${project_id}/custom-fields`, rest);

      if (!result.ok) {
        const scopeErr = handleScopeError('create_custom_field', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error creating custom field: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'update_custom_field',
    description: 'Update a custom-field definition. Only the supplied fields change.',
    input: {
      custom_field_id: z.string().uuid().describe('The custom-field definition UUID'),
      name: z.string().max(255).optional().describe('New name'),
      field_type: customFieldType.optional().describe('New field type'),
      options: z.unknown().optional().describe('New type-specific options'),
      is_required: z.boolean().optional().describe('New required flag'),
      is_visible_on_card: z.boolean().optional().describe('New show-on-card flag'),
      position: z.number().int().optional().describe('New display order'),
    },
    returns: z.object({ data: customFieldShape }),
    handler: async ({ custom_field_id, ...updates }) => {
      const result = await api.patch(`/custom-fields/${custom_field_id}`, updates);

      if (!result.ok) {
        const scopeErr = handleScopeError('update_custom_field', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error updating custom field: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'delete_custom_field',
    description: 'Delete a custom-field definition (destructive). Requires confirm:true — the first call without it returns a confirmation prompt and changes nothing.',
    input: {
      custom_field_id: z.string().uuid().describe('The custom-field definition UUID to delete'),
      confirm: z.boolean().describe('Must be true to confirm deletion'),
    },
    returns: z.object({ data: z.object({ success: z.boolean() }) }),
    handler: async ({ custom_field_id, confirm }) => {
      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: `Are you sure you want to delete custom field ${custom_field_id}? Call this tool again with confirm: true to proceed.`,
          }],
        };
      }

      const result = await api.delete(`/custom-fields/${custom_field_id}`);

      if (!result.ok) {
        const scopeErr = handleScopeError('delete_custom_field', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error deleting custom field: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  // ─── Labels (create/update/delete; bam_list_labels covers the reads) ─────
  const labelShape = z
    .object({
      id: z.string().uuid(),
      project_id: z.string().uuid(),
      name: z.string(),
      color: z.string().nullable().optional(),
      description: z.string().nullable().optional(),
      position: z.number().optional(),
    })
    .passthrough();

  registerTool(server, {
    name: 'create_label',
    description: 'Create a label in a project.',
    input: {
      project_id: z.string().uuid().describe('The project ID'),
      name: z.string().max(100).describe('Label name'),
      color: z.string().max(7).optional().describe('Hex color (e.g. #4F46E5)'),
      description: z.string().optional().describe('Label description'),
      position: z.number().int().optional().describe('Display order (default 0)'),
    },
    returns: z.object({ data: labelShape }),
    handler: async ({ project_id, ...rest }) => {
      const result = await api.post(`/projects/${project_id}/labels`, rest);

      if (!result.ok) {
        const scopeErr = handleScopeError('create_label', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error creating label: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'update_label',
    description: 'Update a label. Only the supplied fields change.',
    input: {
      label_id: z.string().uuid().describe('The label UUID'),
      name: z.string().max(100).optional().describe('New label name'),
      color: z.string().max(7).nullable().optional().describe('New hex color (null clears it)'),
      description: z.string().nullable().optional().describe('New description (null clears it)'),
      position: z.number().int().optional().describe('New display order'),
    },
    returns: z.object({ data: labelShape }),
    handler: async ({ label_id, ...updates }) => {
      const result = await api.patch(`/labels/${label_id}`, updates);

      if (!result.ok) {
        const scopeErr = handleScopeError('update_label', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error updating label: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'delete_label',
    description: 'Delete a label (destructive). Requires confirm:true — the first call without it returns a confirmation prompt and changes nothing.',
    input: {
      label_id: z.string().uuid().describe('The label UUID to delete'),
      confirm: z.boolean().describe('Must be true to confirm deletion'),
    },
    returns: z.object({ data: z.object({ success: z.boolean() }) }),
    handler: async ({ label_id, confirm }) => {
      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: `Are you sure you want to delete label ${label_id}? Call this tool again with confirm: true to proceed.`,
          }],
        };
      }

      const result = await api.delete(`/labels/${label_id}`);

      if (!result.ok) {
        const scopeErr = handleScopeError('delete_label', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error deleting label: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  // ─── Phases (board columns) ──────────────────────────────────────────────
  const phaseShape = z
    .object({
      id: z.string().uuid(),
      project_id: z.string().uuid(),
      name: z.string(),
      description: z.string().nullable().optional(),
      color: z.string().nullable().optional(),
      position: z.number().optional(),
      wip_limit: z.number().nullable().optional(),
      is_start: z.boolean().optional(),
      is_terminal: z.boolean().optional(),
      auto_state_on_enter: z.string().uuid().nullable().optional(),
    })
    .passthrough();

  registerTool(server, {
    name: 'create_phase',
    description: 'Create a phase (board column) in a project at the given position. Existing phases at or after that position shift down to make room.',
    input: {
      project_id: z.string().uuid().describe('The project ID'),
      name: z.string().max(100).describe('Phase name'),
      position: z.number().int().min(0).describe('Insertion position (0-based)'),
      description: z.string().optional().describe('Phase description'),
      color: z.string().optional().describe('Hex color'),
      wip_limit: z.number().int().positive().nullable().optional().describe('Work-in-progress limit'),
      is_start: z.boolean().optional().describe('Whether this is the start phase'),
      is_terminal: z.boolean().optional().describe('Whether this is a terminal (done) phase'),
      auto_state_on_enter: z.string().uuid().nullable().optional().describe('State UUID to auto-apply when a task enters this phase'),
    },
    returns: z.object({ data: phaseShape }),
    handler: async ({ project_id, ...rest }) => {
      const result = await api.post(`/projects/${project_id}/phases`, rest);

      if (!result.ok) {
        const scopeErr = handleScopeError('create_phase', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error creating phase: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'update_phase',
    description: 'Update a phase. Only the supplied fields change.',
    input: {
      phase_id: z.string().uuid().describe('The phase UUID'),
      name: z.string().max(100).optional().describe('New phase name'),
      description: z.string().optional().describe('New description'),
      color: z.string().optional().describe('New hex color'),
      position: z.number().int().min(0).optional().describe('New position'),
      wip_limit: z.number().int().positive().nullable().optional().describe('New WIP limit (null clears it)'),
      is_start: z.boolean().optional().describe('New start-phase flag'),
      is_terminal: z.boolean().optional().describe('New terminal-phase flag'),
      auto_state_on_enter: z.string().uuid().nullable().optional().describe('New auto-state UUID (null clears it)'),
    },
    returns: z.object({ data: phaseShape }),
    handler: async ({ phase_id, ...updates }) => {
      const result = await api.patch(`/phases/${phase_id}`, updates);

      if (!result.ok) {
        const scopeErr = handleScopeError('update_phase', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error updating phase: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'delete_phase',
    description: 'Delete a phase (destructive). Optionally migrate any tasks in it to another phase first via migrate_to (strongly recommended — tasks left orphaned will reference a missing phase). Requires confirm:true.',
    input: {
      phase_id: z.string().uuid().describe('The phase UUID to delete'),
      migrate_to: z.string().uuid().optional().describe('Phase UUID to move this phase\'s tasks into before deleting'),
      confirm: z.boolean().describe('Must be true to confirm deletion'),
    },
    returns: z.object({ data: z.object({ success: z.boolean() }) }),
    handler: async ({ phase_id, migrate_to, confirm }) => {
      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: `Are you sure you want to delete phase ${phase_id}? ${migrate_to ? `Tasks will be migrated to ${migrate_to}. ` : 'No migrate_to was supplied — tasks in this phase will be orphaned. '}Call this tool again with confirm: true to proceed.`,
          }],
        };
      }

      const qs = migrate_to ? `?migrate_to=${encodeURIComponent(migrate_to)}` : '';
      const result = await api.delete(`/phases/${phase_id}${qs}`);

      if (!result.ok) {
        const scopeErr = handleScopeError('delete_phase', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error deleting phase: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'reorder_phases',
    description: 'Reorder all phases in a project. Pass the complete ordered array of phase UUIDs; positions are reassigned to match the array order.',
    input: {
      project_id: z.string().uuid().describe('The project ID'),
      phase_ids: z.array(z.string().uuid()).min(1).describe('Phase UUIDs in the desired order'),
    },
    returns: z.object({ data: z.array(phaseShape) }),
    handler: async ({ project_id, phase_ids }) => {
      const result = await api.post(`/projects/${project_id}/phases/reorder`, { phase_ids });

      if (!result.ok) {
        const scopeErr = handleScopeError('reorder_phases', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error reordering phases: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  // ─── Saved views ─────────────────────────────────────────────────────────
  const viewType = z.enum(['board', 'list', 'timeline', 'calendar', 'workload']);
  const savedViewShape = z
    .object({
      id: z.string().uuid(),
      project_id: z.string().uuid(),
      user_id: z.string().uuid(),
      name: z.string(),
      filters: z.record(z.unknown()).optional(),
      sort: z.string().nullable().optional(),
      view_type: z.string().optional(),
      swimlane: z.string().nullable().optional(),
      is_shared: z.boolean().optional(),
    })
    .passthrough();

  registerTool(server, {
    name: 'list_views',
    description: 'List the saved views in a project visible to the caller: their own views plus any shared views.',
    input: {
      project_id: z.string().uuid().describe('The project ID'),
    },
    returns: z.object({ data: z.array(savedViewShape) }),
    handler: async ({ project_id }) => {
      const result = await api.get(`/projects/${project_id}/views`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error listing views: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'create_view',
    description: 'Create a saved view (a named filter/sort/swimlane configuration) in a project. Set is_shared:true to make it visible to the whole project.',
    input: {
      project_id: z.string().uuid().describe('The project ID'),
      name: z.string().min(1).max(255).describe('View name'),
      filters: z.record(z.unknown()).optional().describe('Filter configuration (field -> value map)'),
      sort: z.string().max(100).optional().describe("Sort spec (e.g. '-priority')"),
      view_type: viewType.optional().describe("View type (defaults to 'board')"),
      swimlane: z.string().max(50).optional().describe('Swimlane grouping field'),
      is_shared: z.boolean().optional().describe('Share with the whole project (default false)'),
    },
    returns: z.object({ data: savedViewShape }),
    handler: async ({ project_id, ...rest }) => {
      const result = await api.post(`/projects/${project_id}/views`, rest);

      if (!result.ok) {
        const scopeErr = handleScopeError('create_view', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error creating view: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'update_view',
    description: 'Update one of your OWN saved views. Only the supplied fields change. The API rejects editing another user\'s view with 403.',
    input: {
      view_id: z.string().uuid().describe('The saved-view UUID'),
      name: z.string().min(1).max(255).optional().describe('New name'),
      filters: z.record(z.unknown()).optional().describe('New filter configuration'),
      sort: z.string().max(100).nullable().optional().describe('New sort spec (null clears it)'),
      view_type: viewType.optional().describe('New view type'),
      swimlane: z.string().max(50).nullable().optional().describe('New swimlane (null clears it)'),
      is_shared: z.boolean().optional().describe('New shared flag'),
    },
    returns: z.object({ data: savedViewShape }),
    handler: async ({ view_id, ...updates }) => {
      const result = await api.patch(`/views/${view_id}`, updates);

      if (!result.ok) {
        const scopeErr = handleScopeError('update_view', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error updating view: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'delete_view',
    description: 'Delete one of your OWN saved views (destructive). The API rejects deleting another user\'s view with 403. Requires confirm:true.',
    input: {
      view_id: z.string().uuid().describe('The saved-view UUID to delete'),
      confirm: z.boolean().describe('Must be true to confirm deletion'),
    },
    returns: z.object({ data: z.object({ success: z.boolean() }) }),
    handler: async ({ view_id, confirm }) => {
      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: `Are you sure you want to delete view ${view_id}? Call this tool again with confirm: true to proceed.`,
          }],
        };
      }

      const result = await api.delete(`/views/${view_id}`);

      if (!result.ok) {
        const scopeErr = handleScopeError('delete_view', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error deleting view: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });
}
