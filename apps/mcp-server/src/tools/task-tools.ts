import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { isUuid } from '../middleware/resolve-helpers.js';
import { handleScopeError } from '../middleware/scope-check.js';
import { registerTool } from '../lib/register-tool.js';

/**
 * Bam-specific name-or-id resolvers (Phase D / Tier 3).
 *
 * Rule authors and ad-hoc MCP callers frequently refer to Bam entities by
 * natural identifiers: "Website Redesign" instead of the project UUID, "Done"
 * instead of a state UUID, "FRND-42" instead of a task UUID, an email address
 * instead of a user UUID. Each of the write tools below relaxes its Zod
 * schema to a plain `z.string()` and runs the input through one of these
 * helpers before making the REST call.
 *
 * Each helper short-circuits when given a UUID (via `isUuid`) so existing
 * UUID-passing callers pay no extra latency. On a miss we return `null` and
 * let the caller emit a clean "not found" error that names the unresolved
 * input.
 */

interface NamedRow {
  id: string;
  name: string;
}

async function resolveProjectId(api: ApiClient, nameOrId: string): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;
  // No dedicated by-name endpoint for projects — list and filter client-side.
  // `/projects` returns every project the caller can see in their active org.
  const result = await api.get('/projects');
  if (!result.ok) return null;
  const projects = ((result.data as { data?: NamedRow[] } | null)?.data) ?? [];
  const needle = nameOrId.toLowerCase();
  const match = projects.find((p) => p.name.toLowerCase() === needle);
  return match?.id ?? null;
}

async function resolvePhaseId(
  api: ApiClient,
  projectId: string,
  nameOrId: string,
): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;
  const result = await api.get(`/projects/${projectId}/phases`);
  if (!result.ok) return null;
  const phases = ((result.data as { data?: NamedRow[] } | null)?.data) ?? [];
  const needle = nameOrId.toLowerCase();
  const match = phases.find((p) => p.name.toLowerCase() === needle);
  return match?.id ?? null;
}

async function resolveLabelIds(
  api: ApiClient,
  projectId: string,
  namesOrIds: string[],
): Promise<string[]> {
  // Fetch once per call; most create_task invocations will pass at most a
  // handful of labels so looping the round-trip would be wasteful.
  const result = await api.get(`/projects/${projectId}/labels`);
  if (!result.ok) {
    // Fall back to whatever was already a UUID — anything non-UUID is dropped
    // because we can't verify it exists.
    return namesOrIds.filter((item) => isUuid(item));
  }
  const labels = ((result.data as { data?: NamedRow[] } | null)?.data) ?? [];
  const resolved: string[] = [];
  for (const item of namesOrIds) {
    if (isUuid(item)) {
      resolved.push(item);
      continue;
    }
    const needle = item.toLowerCase();
    const match = labels.find((l) => l.name.toLowerCase() === needle);
    if (match) resolved.push(match.id);
  }
  return resolved;
}

async function resolveStateId(
  api: ApiClient,
  projectId: string,
  nameOrIdOrCategory: string,
): Promise<string | null> {
  if (isUuid(nameOrIdOrCategory)) return nameOrIdOrCategory;
  const result = await api.get(`/projects/${projectId}/states`);
  if (!result.ok) return null;
  const states =
    ((result.data as { data?: Array<NamedRow & { category: string }> } | null)?.data) ?? [];
  const needle = nameOrIdOrCategory.toLowerCase();
  // Exact name match wins; fall back to category (e.g. "done" → the "done"
  // state in projects that use the default state set).
  const match =
    states.find((s) => s.name.toLowerCase() === needle) ??
    states.find((s) => s.category.toLowerCase() === needle);
  return match?.id ?? null;
}

async function resolveSprintId(
  api: ApiClient,
  projectId: string,
  nameOrId: string,
): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;
  const result = await api.get(`/projects/${projectId}/sprints`);
  if (!result.ok) return null;
  const sprints = ((result.data as { data?: NamedRow[] } | null)?.data) ?? [];
  const needle = nameOrId.toLowerCase();
  const match = sprints.find((s) => s.name.toLowerCase() === needle);
  return match?.id ?? null;
}

async function resolveUserIdByEmailOrName(
  api: ApiClient,
  idOrEmailOrName: string,
): Promise<string | null> {
  if (isUuid(idOrEmailOrName)) return idOrEmailOrName;
  if (idOrEmailOrName.includes('@')) {
    const result = await api.get(
      `/users/by-email?email=${encodeURIComponent(idOrEmailOrName)}`,
    );
    if (!result.ok) return null;
    return ((result.data as { data?: { id: string } | null } | null)?.data)?.id ?? null;
  }
  // Fall back to fuzzy display-name search. The endpoint is rank-ordered so
  // the first hit is the best match.
  const result = await api.get(
    `/users/search?q=${encodeURIComponent(idOrEmailOrName)}&limit=1`,
  );
  if (!result.ok) return null;
  const users = ((result.data as { data?: Array<{ id: string }> } | null)?.data) ?? [];
  return users[0]?.id ?? null;
}

/**
 * Resolve a task identifier that may be a UUID or a human_id like "FRND-42".
 * Exported so sibling tool modules (e.g. comment-tools.ts) can reuse it.
 */
export async function resolveTaskId(
  api: ApiClient,
  idOrHumanId: string,
): Promise<string | null> {
  if (isUuid(idOrHumanId)) return idOrHumanId;
  const trimmed = idOrHumanId.trim().replace(/^#/, '');
  if (/^[A-Z]+-\d+$/i.test(trimmed)) {
    const result = await api.get(`/tasks/by-ref/${encodeURIComponent(trimmed)}`);
    if (!result.ok) return null;
    return ((result.data as { data?: { id: string } | null } | null)?.data)?.id ?? null;
  }
  return null;
}

async function resolveTemplateId(
  api: ApiClient,
  projectId: string,
  nameOrId: string,
): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;
  const result = await api.get(`/projects/${projectId}/task-templates`);
  if (!result.ok) return null;
  const templates = ((result.data as { data?: NamedRow[] } | null)?.data) ?? [];
  const needle = nameOrId.toLowerCase();
  const match = templates.find((t) => t.name.toLowerCase() === needle);
  return match?.id ?? null;
}

// Re-export for template-tools.ts (kept in the same file to avoid creating a
// brand-new Bam resolver module for a handful of helpers).
export { resolveProjectId, resolveTemplateId };

function err(label: string, data: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error ${label}: ${JSON.stringify(data)}` }],
    isError: true as const,
  };
}

const taskShape = z.object({
  id: z.string().uuid(),
  human_id: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  state_id: z.string().uuid().nullable().optional(),
  state_category: z.string().optional(),
  priority: z.string().optional(),
  story_points: z.number().nullable().optional(),
  assignee_id: z.string().uuid().nullable().optional(),
  sprint_id: z.string().uuid().nullable().optional(),
  phase_id: z.string().uuid().optional(),
  project_id: z.string().uuid().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

export function registerTaskTools(server: McpServer, api: ApiClient): void {
  registerTool(server, {
    name: 'search_tasks',
    description: 'Search and filter tasks in a project',
    input: {
      project_id: z.string().uuid().describe('The project UUID'),
      q: z.string().optional().describe('Search query string'),
      phase_id: z.string().uuid().optional().describe('Filter by phase UUID'),
      sprint_id: z.string().uuid().optional().describe('Filter by sprint UUID'),
      assignee_id: z.string().uuid().optional().describe('Filter by assignee UUID'),
      priority: z.enum(['critical', 'high', 'medium', 'low', 'none']).optional().describe('Filter by priority'),
      state_category: z.enum(['todo', 'active', 'blocked', 'review', 'done', 'cancelled']).optional().describe('Filter by state category'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(200).optional().describe('Number of results'),
    },
    returns: z.object({ data: z.array(taskShape), next_cursor: z.string().nullable().optional() }),
    handler: async ({ project_id, ...filters }) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined) params.set(key, String(value));
      }

      const qs = params.toString();
      const result = await api.get(`/projects/${project_id}/tasks${qs ? `?${qs}` : ''}`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error searching tasks: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'get_task',
    description: 'Get detailed information about a specific task',
    input: {
      task_id: z.string().uuid().describe('The task ID'),
    },
    returns: taskShape,
    handler: async ({ task_id }) => {
      const result = await api.get(`/tasks/${task_id}`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error getting task: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'bam_get_task_by_human_id',
    description: "Look up a task by its human-readable reference (e.g. 'FRND-42'). The prefix is case-insensitive. Returns the task's id, project_id, human_id, and title. Useful when a prompt or rule refers to a task by its ticket number rather than UUID.",
    input: {
      human_id: z.string().min(3).describe("Human-readable task ID like 'FRND-42' (case-insensitive prefix)"),
    },
    returns: z.object({ id: z.string().uuid(), project_id: z.string().uuid(), human_id: z.string(), title: z.string() }).passthrough(),
    handler: async ({ human_id }) => {
      const ref = encodeURIComponent(human_id.trim().replace(/^#/, ''));
      const result = await api.get(`/tasks/by-ref/${ref}`);

      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error resolving task ${human_id}: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'create_task',
    description: 'Create a new task in a project. Accepts natural identifiers (project name, phase name, sprint name, label name, user email) in addition to UUIDs.',
    input: {
      project_id: z
        .string()
        .describe('Project name or UUID'),
      title: z.string().max(500).describe('Task title'),
      phase_id: z
        .string()
        .describe('Phase name (scoped to the project) or UUID'),
      description: z.string().optional().describe('Task description (markdown)'),
      sprint_id: z
        .string()
        .nullable()
        .optional()
        .describe('Sprint name or UUID to assign to'),
      assignee_id: z
        .string()
        .nullable()
        .optional()
        .describe('Assignee — UUID, email address, or display name'),
      priority: z.enum(['critical', 'high', 'medium', 'low', 'none']).optional().describe('Priority level'),
      story_points: z.number().int().positive().nullable().optional().describe('Story point estimate'),
      label_ids: z
        .array(z.string())
        .optional()
        .describe('Labels to attach — each entry may be a label name or UUID'),
      epic_id: z.string().uuid().nullable().optional().describe('Epic to link to'),
      parent_task_id: z.string().uuid().nullable().optional().describe('Parent task for sub-tasks'),
    },
    returns: taskShape,
    handler: async ({ project_id, phase_id, sprint_id, assignee_id, label_ids, ...rest }) => {
      const resolvedProjectId = await resolveProjectId(api, project_id);
      if (!resolvedProjectId) {
        return err(
          'creating task',
          `Project '${project_id}' could not be resolved by name or UUID`,
        );
      }

      // Resolve all project-scoped lookups in parallel — they're independent
      // and hit different REST endpoints.
      const [
        resolvedPhaseId,
        resolvedSprintId,
        resolvedAssigneeId,
        resolvedLabelIds,
      ] = await Promise.all([
        resolvePhaseId(api, resolvedProjectId, phase_id),
        sprint_id != null ? resolveSprintId(api, resolvedProjectId, sprint_id) : Promise.resolve(null),
        assignee_id != null ? resolveUserIdByEmailOrName(api, assignee_id) : Promise.resolve(null),
        label_ids && label_ids.length > 0
          ? resolveLabelIds(api, resolvedProjectId, label_ids)
          : Promise.resolve<string[]>([]),
      ]);

      if (!resolvedPhaseId) {
        return err(
          'creating task',
          `Phase '${phase_id}' could not be resolved in project '${project_id}'`,
        );
      }
      if (sprint_id != null && resolvedSprintId == null) {
        return err(
          'creating task',
          `Sprint '${sprint_id}' could not be resolved in project '${project_id}'`,
        );
      }
      if (assignee_id != null && resolvedAssigneeId == null) {
        return err(
          'creating task',
          `Assignee '${assignee_id}' could not be resolved by UUID, email, or display name`,
        );
      }

      const taskData: Record<string, unknown> = {
        ...rest,
        phase_id: resolvedPhaseId,
      };
      if (sprint_id !== undefined) taskData.sprint_id = resolvedSprintId;
      if (assignee_id !== undefined) taskData.assignee_id = resolvedAssigneeId;
      if (label_ids !== undefined) taskData.label_ids = resolvedLabelIds;

      const result = await api.post(`/projects/${resolvedProjectId}/tasks`, taskData);

      if (!result.ok) {
        const scopeErr = handleScopeError('create_task', 'read_write', result);
        if (scopeErr) return scopeErr;
        return err('creating task', result.data);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'update_task',
    description: 'Update an existing task. Accepts natural identifiers for task, assignee, state, and sprint in addition to UUIDs.',
    input: {
      task_id: z
        .string()
        .describe("Task UUID or human_id (e.g. 'FRND-42')"),
      title: z.string().max(500).optional().describe('New title'),
      description: z.string().optional().describe('New description'),
      assignee_id: z
        .string()
        .nullable()
        .optional()
        .describe('New assignee — UUID, email, or display name'),
      priority: z.enum(['critical', 'high', 'medium', 'low', 'none']).optional().describe('New priority'),
      story_points: z.number().int().positive().nullable().optional().describe('New story points'),
      sprint_id: z
        .string()
        .nullable()
        .optional()
        .describe('New sprint — name or UUID'),
      state_id: z
        .string()
        .optional()
        .describe("New state — name (e.g. 'Done'), category, or UUID"),
      start_date: z.string().optional().describe('Start date (ISO 8601)'),
      due_date: z.string().optional().describe('Due date (ISO 8601)'),
    },
    returns: taskShape,
    handler: async ({ task_id, assignee_id, sprint_id, state_id, ...rest }) => {
      const resolvedTaskId = await resolveTaskId(api, task_id);
      if (!resolvedTaskId) {
        return err(
          'updating task',
          `Task '${task_id}' could not be resolved by UUID or human_id`,
        );
      }

      // If we need to resolve a project-scoped field (state, sprint), fetch
      // the task once to get its project_id. We skip the fetch when none of
      // those fields were supplied so the common "just change the title"
      // case stays a single round-trip.
      const needsProject =
        (sprint_id != null && !isUuid(sprint_id)) ||
        (state_id != null && !isUuid(state_id));

      let projectId: string | null = null;
      if (needsProject) {
        const taskResult = await api.get(`/tasks/${resolvedTaskId}`);
        if (!taskResult.ok) {
          return err('updating task', taskResult.data);
        }
        const taskEnvelope = taskResult.data as { data?: { project_id?: string } } | null;
        projectId = taskEnvelope?.data?.project_id ?? null;
        if (!projectId) {
          return err(
            'updating task',
            `Could not determine project for task '${task_id}' while resolving state/sprint`,
          );
        }
      }

      const [resolvedAssigneeId, resolvedSprintId, resolvedStateId] = await Promise.all([
        assignee_id != null ? resolveUserIdByEmailOrName(api, assignee_id) : Promise.resolve(null),
        sprint_id != null && projectId
          ? resolveSprintId(api, projectId, sprint_id)
          : Promise.resolve(sprint_id != null && isUuid(sprint_id) ? sprint_id : null),
        state_id != null && projectId
          ? resolveStateId(api, projectId, state_id)
          : Promise.resolve(state_id != null && isUuid(state_id) ? state_id : null),
      ]);

      if (assignee_id != null && resolvedAssigneeId == null) {
        return err(
          'updating task',
          `Assignee '${assignee_id}' could not be resolved by UUID, email, or display name`,
        );
      }
      if (sprint_id != null && resolvedSprintId == null) {
        return err(
          'updating task',
          `Sprint '${sprint_id}' could not be resolved on this task's project`,
        );
      }
      if (state_id != null && resolvedStateId == null) {
        return err(
          'updating task',
          `State '${state_id}' could not be resolved on this task's project`,
        );
      }

      const updates: Record<string, unknown> = { ...rest };
      if (assignee_id !== undefined) updates.assignee_id = resolvedAssigneeId;
      if (sprint_id !== undefined) updates.sprint_id = resolvedSprintId;
      if (state_id !== undefined) updates.state_id = resolvedStateId;

      const result = await api.patch(`/tasks/${resolvedTaskId}`, updates);

      if (!result.ok) {
        const scopeErr = handleScopeError('update_task', 'read_write', result);
        if (scopeErr) return scopeErr;
        return err('updating task', result.data);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'move_task',
    description: 'Move a task to a different phase and/or position on the board. Accepts natural identifiers for task and phase.',
    input: {
      task_id: z
        .string()
        .describe("Task UUID or human_id (e.g. 'FRND-42')"),
      phase_id: z
        .string()
        .describe('Target phase name (scoped to the task\'s project) or UUID'),
      position: z.number().int().min(0).describe('Position within the phase'),
      sprint_id: z
        .string()
        .nullable()
        .optional()
        .describe('Optionally change sprint — name or UUID'),
    },
    returns: taskShape,
    handler: async ({ task_id, phase_id, position, sprint_id }) => {
      const resolvedTaskId = await resolveTaskId(api, task_id);
      if (!resolvedTaskId) {
        return err(
          'moving task',
          `Task '${task_id}' could not be resolved by UUID or human_id`,
        );
      }

      // Short-circuit the project fetch when every project-scoped field
      // the caller supplied was already a UUID.
      const needsProject =
        !isUuid(phase_id) || (sprint_id != null && !isUuid(sprint_id));

      let projectId: string | null = null;
      if (needsProject) {
        const taskResult = await api.get(`/tasks/${resolvedTaskId}`);
        if (!taskResult.ok) {
          return err('moving task', taskResult.data);
        }
        const taskEnvelope = taskResult.data as { data?: { project_id?: string } } | null;
        projectId = taskEnvelope?.data?.project_id ?? null;
        if (!projectId) {
          return err(
            'moving task',
            `Could not determine project for task '${task_id}' while resolving phase/sprint`,
          );
        }
      }

      const [resolvedPhaseId, resolvedSprintId] = await Promise.all([
        isUuid(phase_id)
          ? Promise.resolve(phase_id)
          : resolvePhaseId(api, projectId as string, phase_id),
        sprint_id == null
          ? Promise.resolve(null)
          : isUuid(sprint_id)
          ? Promise.resolve(sprint_id)
          : resolveSprintId(api, projectId as string, sprint_id),
      ]);

      if (!resolvedPhaseId) {
        return err(
          'moving task',
          `Phase '${phase_id}' could not be resolved on this task's project`,
        );
      }
      if (sprint_id != null && resolvedSprintId == null) {
        return err(
          'moving task',
          `Sprint '${sprint_id}' could not be resolved on this task's project`,
        );
      }

      const moveData: Record<string, unknown> = {
        phase_id: resolvedPhaseId,
        position,
      };
      if (sprint_id !== undefined) moveData.sprint_id = resolvedSprintId;

      const result = await api.post(`/tasks/${resolvedTaskId}/move`, moveData);

      if (!result.ok) {
        const scopeErr = handleScopeError('move_task', 'read_write', result);
        if (scopeErr) return scopeErr;
        return err('moving task', result.data);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'delete_task',
    description: 'Delete a task (destructive action - will ask for confirmation)',
    input: {
      task_id: z.string().uuid().describe('The task ID to delete'),
      confirm: z.boolean().describe('Must be true to confirm deletion'),
    },
    returns: z.object({ ok: z.boolean() }),
    handler: async ({ task_id, confirm }) => {
      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: `Are you sure you want to delete task ${task_id}? Call this tool again with confirm: true to proceed.`,
          }],
        };
      }

      const result = await api.delete(`/tasks/${task_id}`);

      if (!result.ok) {
        const scopeErr = handleScopeError('delete_task', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error deleting task: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: `Task ${task_id} deleted successfully.` }],
      };
    },
  });

  registerTool(server, {
    name: 'bulk_update_tasks',
    description: 'Perform a bulk operation on multiple tasks at once. Each task_ids entry may be a UUID or a human_id (e.g. FRND-42).',
    input: {
      task_ids: z
        .array(z.string())
        .min(1)
        .describe('Array of task UUIDs or human_ids (e.g. FRND-42) to update'),
      operation: z
        .enum(['update', 'move', 'delete', 'assign', 'set_sprint'])
        .describe('The bulk operation to perform'),
      fields: z
        .record(z.unknown())
        .optional()
        .describe(
          'Fields to set (depends on operation): e.g. { priority, assignee_id, phase_id, sprint_id }. ' +
            'NOTE: name-or-id resolution currently applies only to task_ids; sub-keys inside fields ' +
            '(assignee_id/phase_id/sprint_id) must still be UUIDs.',
        ),
    },
    returns: z.object({ updated: z.number(), failed: z.number().optional() }),
    handler: async ({ task_ids, operation, fields }) => {
      // Resolve each task id (UUID or human_id) in parallel. Callers that
      // pass all UUIDs pay nothing because `resolveTaskId` short-circuits.
      const resolved = await Promise.all(task_ids.map((id) => resolveTaskId(api, id)));
      const unresolved: string[] = [];
      const resolvedIds: string[] = [];
      for (let i = 0; i < resolved.length; i++) {
        const r = resolved[i];
        if (r == null) unresolved.push(task_ids[i] ?? '');
        else resolvedIds.push(r);
      }
      if (unresolved.length > 0) {
        return err(
          'bulk updating tasks',
          `Could not resolve task identifiers: ${unresolved.join(', ')}`,
        );
      }

      // TODO(phase-d-followup): the `fields` payload is a free-form record so
      // we cannot validate it against a Zod schema. Resolving nested name-or-id
      // values (fields.assignee_id, fields.phase_id, fields.sprint_id) is
      // tractable but requires knowing the target project, which for
      // cross-project bulk operations means fetching every task first.
      // Deferred until we see demand; document-only for now.

      const result = await api.post('/tasks/bulk', {
        task_ids: resolvedIds,
        operation,
        fields,
      });

      if (!result.ok) {
        const scopeErr = handleScopeError('bulk_update_tasks', 'read_write', result);
        if (scopeErr) return scopeErr;
        return err('bulk updating tasks', result.data);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'log_time',
    description: 'Log time spent on a task',
    input: {
      task_id: z.string().uuid().describe('The task ID'),
      minutes: z.number().int().positive().describe('Number of minutes spent'),
      date: z.string().describe('Date of the time entry (ISO 8601)'),
      description: z.string().optional().describe('Description of work done'),
    },
    returns: z.object({ id: z.string().uuid(), task_id: z.string().uuid(), minutes: z.number(), date: z.string() }).passthrough(),
    handler: async ({ task_id, ...timeData }) => {
      const result = await api.post(`/tasks/${task_id}/time-entries`, timeData);

      if (!result.ok) {
        const scopeErr = handleScopeError('log_time', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error logging time: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'duplicate_task',
    description: 'Duplicate an existing task, optionally including its subtasks',
    input: {
      task_id: z.string().uuid().describe('The task ID to duplicate'),
      include_subtasks: z.boolean().optional().describe('Whether to also duplicate subtasks (default false)'),
    },
    returns: taskShape,
    handler: async ({ task_id, include_subtasks }) => {
      const result = await api.post(`/tasks/${task_id}/duplicate`, { include_subtasks: include_subtasks ?? false });

      if (!result.ok) {
        const scopeErr = handleScopeError('duplicate_task', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error duplicating task: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  registerTool(server, {
    name: 'import_csv',
    description: 'Import tasks from CSV data into a project',
    input: {
      project_id: z.string().uuid().describe('The project ID'),
      rows: z.array(z.record(z.string())).describe('Array of row objects from the CSV'),
      mapping: z.record(z.string()).describe('Mapping of CSV column names to task fields (e.g. { "Title": "title", "Priority": "priority" })'),
    },
    returns: z.object({ imported: z.number(), failed: z.number().optional(), errors: z.array(z.string()).optional() }),
    handler: async ({ project_id, rows, mapping }) => {
      const result = await api.post(`/projects/${project_id}/import/csv`, { rows, mapping });

      if (!result.ok) {
        const scopeErr = handleScopeError('import_csv', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error importing CSV: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });

  // §14 Wave 4: idempotent create-or-update of a task by (project_id,
  // external_id). Designed for webhook intake and import flows where the
  // upstream system has its own stable identifier and retries are common.
  registerTool(server, {
    name: 'task_upsert_by_external_id',
    description: 'Idempotent create-or-update of a task by (project_id, external_id). Natural key is the partial unique index on (project_id, external_id). On insert, allocates a new human_id and accepts the full create payload. On update, patches the supplied fields; human_id is preserved. Returns { data, created, idempotency_key } — `created` is true on insert, false on update.',
    input: {
      project_id: z.string().uuid().describe('Project UUID'),
      external_id: z.string().min(1).max(256).describe('External idempotency key (e.g. upstream ticket id). Globally unique within the project.'),
      title: z.string().min(1).max(500).describe('Task title'),
      description: z.string().nullable().optional().describe('Task description (Markdown)'),
      phase_id: z.string().uuid().nullable().optional().describe('Phase UUID (defaults to first phase by position on insert)'),
      state_id: z.string().uuid().nullable().optional().describe('State UUID (defaults to the phase auto-state on insert)'),
      sprint_id: z.string().uuid().nullable().optional().describe('Sprint UUID'),
      epic_id: z.string().uuid().nullable().optional().describe('Epic UUID'),
      assignee_id: z.string().uuid().nullable().optional().describe('Assignee user UUID'),
      priority: z.enum(['critical', 'high', 'medium', 'low', 'none']).optional().describe('Priority level'),
      story_points: z.number().int().positive().nullable().optional().describe('Story points estimate'),
      time_estimate_minutes: z.number().int().positive().nullable().optional().describe('Time estimate in minutes'),
      start_date: z.string().nullable().optional().describe('ISO date string (YYYY-MM-DD)'),
      due_date: z.string().nullable().optional().describe('ISO date string (YYYY-MM-DD)'),
      labels: z.array(z.string().uuid()).optional().describe('Label UUIDs to attach'),
      custom_fields: z.record(z.unknown()).optional().describe('Custom field values'),
      parent_task_id: z.string().uuid().nullable().optional().describe('Parent task UUID for subtasks'),
    },
    returns: z.object({
      data: taskShape,
      created: z.boolean(),
      idempotency_key: z.string(),
    }),
    handler: async (params) => {
      const result = await api.post('/v1/tasks/upsert-by-external-id', params);
      if (!result.ok) {
        const scopeErr = handleScopeError('task_upsert_by_external_id', 'read_write', result);
        if (scopeErr) return scopeErr;
        return {
          content: [{ type: 'text' as const, text: `Error upserting task: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }],
      };
    },
  });
}
