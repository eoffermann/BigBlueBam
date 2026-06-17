import { registerTool } from '../lib/register-tool.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { isUuid, resolveProjectId } from '../middleware/resolve-helpers.js';

/**
 * Helper to make requests to the board-api service.
 * Same pattern as bolt-tools.ts — a lightweight fetch wrapper that targets
 * the board-api base URL and forwards the user's auth token.
 */
function createBoardClient(boardApiUrl: string, api: ApiClient) {
  const baseUrl = boardApiUrl.replace(/\/$/, '');

  async function request(method: string, path: string, body?: unknown) {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {};

    // Forward the bearer token from the main API client
    const token = (api as unknown as { token?: string }).token;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    // Tolerate empty (204 No Content) and non-JSON bodies so DELETE/204 tools
    // report success instead of throwing "Unexpected end of JSON input".
    const __text = await res.text();
    let data: unknown = null;
    if (__text) {
      try {
        data = JSON.parse(__text);
      } catch {
        data = __text;
      }
    }
    return { ok: res.ok, status: res.status, data };
  }

  return { request };
}

type BoardClient = ReturnType<typeof createBoardClient>;

/**
 * Resolve a Board identifier that may be either a UUID or a board name.
 * Uses the board-api list endpoint with the native server-side `search`
 * filter (ILIKE name/description) and picks the first case-insensitive exact
 * name match. Optionally scopes the lookup to a project for disambiguation.
 *
 * Returns `null` on miss or ambiguity so callers can surface a clean
 * "Board not found" error.
 */
async function resolveBoardId(
  board: BoardClient,
  nameOrId: string,
  projectId?: string,
): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;
  const params = new URLSearchParams({ search: nameOrId, limit: '50' });
  if (projectId) params.set('project_id', projectId);
  const result = await board.request('GET', `/boards?${params.toString()}`);
  if (!result.ok) return null;
  const envelope = result.data as { data?: Array<{ id: string; name: string }> } | null;
  const boards = envelope?.data ?? [];
  const target = nameOrId.toLowerCase();
  const exact = boards.filter((b) => b.name.toLowerCase() === target);
  if (exact.length === 1) return exact[0]!.id;
  if (exact.length > 1) return null;
  if (boards.length === 1) return boards[0]!.id;
  return null;
}

/**
 * Resolve a Board template identifier that may be either a UUID or a
 * template name. Lists all templates (org-scoped) and picks the first
 * case-insensitive exact name match. Returns `null` on miss.
 */
async function resolveTemplateId(
  board: BoardClient,
  nameOrId: string,
): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;
  const result = await board.request('GET', '/templates');
  if (!result.ok) return null;
  const envelope = result.data as { data?: Array<{ id: string; name: string }> } | null;
  const templates = envelope?.data ?? [];
  const target = nameOrId.toLowerCase();
  const match = templates.find((t) => t.name.toLowerCase() === target);
  return match?.id ?? null;
}

/**
 * Resolve a Bam phase identifier that may be a UUID or a phase name. Phases
 * are project-scoped, so a project UUID is required. Uses the Bam API's
 * `/projects/:id/phases` endpoint which is already org/membership-gated.
 *
 * Returns `null` on miss or ambiguity.
 */
async function resolvePhaseId(
  api: ApiClient,
  projectId: string,
  nameOrId: string,
): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;
  const result = await api.get(`/projects/${projectId}/phases`);
  if (!result.ok) return null;
  const envelope = result.data as { data?: Array<{ id: string; name: string }> } | null;
  const phases = envelope?.data ?? [];
  const target = nameOrId.toLowerCase();
  const matches = phases.filter((p) => p.name.toLowerCase() === target);
  if (matches.length === 1) return matches[0]!.id;
  return null;
}

/**
 * Resolve a user identifier (UUID, email, or free-text name) to a UUID via the
 * shared Bam users table. board-api has no user endpoint — users live in the
 * Bam API and are shared across the suite — so this routes through the main
 * `api` client, mirroring the bearing/bond owner resolvers. Returns `null` on
 * miss so the caller can surface a clean "user not found" error.
 */
async function resolveUserId(api: ApiClient, idOrEmail: string): Promise<string | null> {
  if (isUuid(idOrEmail)) return idOrEmail;
  if (idOrEmail.includes('@')) {
    const result = await api.get(`/users/by-email?email=${encodeURIComponent(idOrEmail)}`);
    if (!result.ok) return null;
    return ((result.data as { data: { id: string } | null }).data)?.id ?? null;
  }
  const result = await api.get(`/users/search?q=${encodeURIComponent(idOrEmail)}&limit=1`);
  if (!result.ok) return null;
  const users = (result.data as { data: Array<{ id: string }> }).data ?? [];
  return users[0]?.id ?? null;
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(label: string, data: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error ${label}: ${JSON.stringify(data)}` }],
    isError: true as const,
  };
}

function buildQs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) sp.set(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

const boardShape = z.object({
  id: z.string().uuid(),
  name: z.string(),
  visibility: z.string().optional(),
  project_id: z.string().uuid().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

const elementShape = z.object({
  id: z.string().uuid(),
  type: z.string(),
  x: z.number().optional(),
  y: z.number().optional(),
  text: z.string().optional(),
}).passthrough();

export function registerBoardTools(server: McpServer, api: ApiClient, boardApiUrl: string): void {
  const client = createBoardClient(boardApiUrl, api);

  // ===== BOARD CRUD (5) =====

  registerTool(server, {
    name: 'board_list',
    description: 'List boards with optional filters and pagination.',
    input: {
      project_id: z.string().uuid().optional().describe('Filter by project'),
      visibility: z.enum(['private', 'project', 'organization']).optional().describe('Filter by visibility'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(100).optional().describe('Page size (default 50, max 100)'),
    },
    returns: z.object({ data: z.array(boardShape), next_cursor: z.string().nullable().optional() }),
    handler: async (params) => {
      const result = await client.request('GET', `/boards${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing boards', result.data);
    },
  });

  registerTool(server, {
    name: 'board_get',
    description: 'Get board metadata by ID.',
    input: {
      id: z.string().uuid().describe('Board ID'),
    },
    returns: boardShape,
    handler: async ({ id }) => {
      const result = await client.request('GET', `/boards/${id}`);
      return result.ok ? ok(result.data) : err('getting board', result.data);
    },
  });

  registerTool(server, {
    name: 'board_create',
    description: 'Create a new visual collaboration board. `template_id` accepts either a UUID or a template name (case-insensitive).',
    input: {
      name: z.string().max(255).describe('Board name (max 255 chars)'),
      description: z.string().max(2000).optional().describe('Description (max 2000 chars)'),
      project_id: z.string().uuid().optional().describe('Project to associate the board with'),
      template_id: z.string().optional().describe('Template UUID or name to initialize the board from'),
      background: z.enum(['dots', 'grid', 'lines', 'plain']).optional().describe('Background pattern (default plain)'),
      visibility: z.enum(['private', 'project', 'organization']).optional().describe('Visibility level (default private)'),
    },
    returns: boardShape,
    handler: async (params) => {
      let body: Record<string, unknown> = { ...params };
      if (params.template_id) {
        const resolvedTemplateId = await resolveTemplateId(client, params.template_id);
        if (!resolvedTemplateId) {
          return err('creating board', {
            error: `Template not found: ${params.template_id}`,
          });
        }
        body.template_id = resolvedTemplateId;
      }
      const result = await client.request('POST', '/boards', body);
      return result.ok ? ok(result.data) : err('creating board', result.data);
    },
  });

  registerTool(server, {
    name: 'board_update',
    description: 'Update board metadata. Provide only the fields to change. `id` accepts either a UUID or a board name.',
    input: {
      id: z.string().describe('Board UUID or name'),
      name: z.string().max(255).optional().describe('Updated name'),
      description: z.string().max(2000).optional().describe('Updated description'),
      background: z.enum(['dots', 'grid', 'lines', 'plain']).optional().describe('Updated background pattern'),
      visibility: z.enum(['private', 'project', 'organization']).optional().describe('Updated visibility'),
      locked: z.boolean().optional().describe('Lock or unlock the board'),
      icon: z.string().max(50).optional().describe('Board icon identifier'),
    },
    returns: boardShape,
    handler: async ({ id, ...body }) => {
      const resolvedId = await resolveBoardId(client, id);
      if (!resolvedId) {
        return err('updating board', {
          error: `Board not found: ${id}`,
        });
      }
      const result = await client.request('PATCH', `/boards/${resolvedId}`, body);
      return result.ok ? ok(result.data) : err('updating board', result.data);
    },
  });

  registerTool(server, {
    name: 'board_archive',
    description: 'Archive a board (soft delete). `id` accepts either a UUID or a board name.',
    input: {
      id: z.string().describe('Board UUID or name'),
    },
    returns: z.object({ ok: z.boolean() }),
    handler: async ({ id }) => {
      const resolvedId = await resolveBoardId(client, id);
      if (!resolvedId) {
        return err('archiving board', {
          error: `Board not found: ${id}`,
        });
      }
      const result = await client.request('DELETE', `/boards/${resolvedId}`);
      return result.ok ? ok(result.data) : err('archiving board', result.data);
    },
  });

  // ===== ELEMENT READING (3) =====

  registerTool(server, {
    name: 'board_read_elements',
    description: 'Read all elements on a board. Returns structured data with positions, text, and types. `id` accepts either a UUID or a board name.',
    input: {
      id: z.string().describe('Board UUID or name'),
    },
    returns: z.object({ data: z.array(elementShape) }),
    handler: async ({ id }) => {
      const resolvedId = await resolveBoardId(client, id);
      if (!resolvedId) {
        return err('reading board elements', {
          error: `Board not found: ${id}`,
        });
      }
      const result = await client.request('GET', `/boards/${resolvedId}/elements`);
      return result.ok ? ok(result.data) : err('reading board elements', result.data);
    },
  });

  registerTool(server, {
    name: 'board_read_stickies',
    description: 'Read only sticky note elements from a board.',
    input: {
      id: z.string().uuid().describe('Board ID'),
    },
    returns: z.object({ data: z.array(elementShape) }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/boards/${id}/elements/stickies`);
      return result.ok ? ok(result.data) : err('reading stickies', result.data);
    },
  });

  registerTool(server, {
    name: 'board_read_frames',
    description: 'Read frames with their contained elements from a board.',
    input: {
      id: z.string().uuid().describe('Board ID'),
    },
    returns: z.object({ data: z.array(elementShape.extend({ children: z.array(elementShape).optional() })) }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/boards/${id}/elements/frames`);
      return result.ok ? ok(result.data) : err('reading frames', result.data);
    },
  });

  // ===== ELEMENT CREATION (2) =====

  const stickyColorMap: Record<string, string> = {
    yellow: '#FFEB3B',
    green: '#4CAF50',
    blue: '#2196F3',
    red: '#F44336',
    purple: '#9C27B0',
    orange: '#FF9800',
  };

  registerTool(server, {
    name: 'board_add_sticky',
    description: 'Add a sticky note to a board. `board_id` accepts either a UUID or a board name.',
    input: {
      board_id: z.string().describe('Board UUID or name'),
      text: z.string().max(1000).describe('Sticky note text (max 1000 chars)'),
      x: z.number().optional().describe('X position on the canvas'),
      y: z.number().optional().describe('Y position on the canvas'),
      color: z.enum(['yellow', 'green', 'blue', 'red', 'purple', 'orange']).optional().describe('Sticky note color (default yellow)'),
    },
    returns: elementShape,
    handler: async ({ board_id, color, ...body }) => {
      const resolvedBoardId = await resolveBoardId(client, board_id);
      if (!resolvedBoardId) {
        return err('adding sticky', {
          error: `Board not found: ${board_id}`,
        });
      }
      const payload = { ...body, color: color ? stickyColorMap[color] ?? '#FFEB3B' : undefined };
      const result = await client.request('POST', `/boards/${resolvedBoardId}/elements/sticky`, payload);
      return result.ok ? ok(result.data) : err('adding sticky', result.data);
    },
  });

  registerTool(server, {
    name: 'board_add_text',
    description: 'Add a text element to a board. `board_id` accepts either a UUID or a board name.',
    input: {
      board_id: z.string().describe('Board UUID or name'),
      text: z.string().max(5000).describe('Text content (max 5000 chars)'),
      x: z.number().optional().describe('X position on the canvas'),
      y: z.number().optional().describe('Y position on the canvas'),
    },
    returns: elementShape,
    handler: async ({ board_id, ...body }) => {
      const resolvedBoardId = await resolveBoardId(client, board_id);
      if (!resolvedBoardId) {
        return err('adding text element', {
          error: `Board not found: ${board_id}`,
        });
      }
      const result = await client.request('POST', `/boards/${resolvedBoardId}/elements/text`, body);
      return result.ok ? ok(result.data) : err('adding text element', result.data);
    },
  });

  // ===== ACTIONS (2) =====

  registerTool(server, {
    name: 'board_promote_to_tasks',
    description: 'Promote sticky notes to Bam tasks in a project. `board_id` accepts either a UUID or a board name. `project_id` accepts either a UUID or a project name. `phase_id` accepts either a UUID or a phase name (scoped to the resolved project).',
    input: {
      board_id: z.string().describe('Board UUID or name'),
      element_ids: z.array(z.string().uuid()).min(1).describe('Array of element IDs to promote'),
      project_id: z.string().describe('Target project UUID or name'),
      phase_id: z.string().optional().describe('Target phase UUID or name (uses default if omitted)'),
    },
    returns: z.object({ created_task_ids: z.array(z.string().uuid()), count: z.number() }).passthrough(),
    handler: async ({ board_id, project_id, phase_id, ...body }) => {
      const resolvedProjectId = await resolveProjectId(api, project_id);
      if (!resolvedProjectId) {
        return err('promoting elements to tasks', {
          error: `Project not found: ${project_id}`,
        });
      }
      const resolvedBoardId = await resolveBoardId(client, board_id, resolvedProjectId);
      if (!resolvedBoardId) {
        return err('promoting elements to tasks', {
          error: `Board not found: ${board_id}`,
        });
      }
      let resolvedPhaseId: string | undefined;
      if (phase_id) {
        const phaseMatch = await resolvePhaseId(api, resolvedProjectId, phase_id);
        if (!phaseMatch) {
          return err('promoting elements to tasks', {
            error: `Phase not found in project ${project_id}: ${phase_id}`,
          });
        }
        resolvedPhaseId = phaseMatch;
      }
      const payload: Record<string, unknown> = {
        ...body,
        project_id: resolvedProjectId,
      };
      if (resolvedPhaseId) payload.phase_id = resolvedPhaseId;
      const result = await client.request('POST', `/boards/${resolvedBoardId}/elements/promote`, payload);
      return result.ok ? ok(result.data) : err('promoting elements to tasks', result.data);
    },
  });

  registerTool(server, {
    name: 'board_export',
    description: 'Export a board as SVG or PNG. `id` accepts either a UUID or a board name.',
    input: {
      id: z.string().describe('Board UUID or name'),
      format: z.enum(['svg', 'png']).describe('Export format'),
    },
    returns: z.object({ url: z.string().optional(), data: z.string().optional() }).passthrough(),
    handler: async ({ id, format }) => {
      const resolvedId = await resolveBoardId(client, id);
      if (!resolvedId) {
        return err('exporting board', {
          error: `Board not found: ${id}`,
        });
      }
      const result = await client.request('POST', `/boards/${resolvedId}/export`, { format });
      return result.ok ? ok(result.data) : err('exporting board', result.data);
    },
  });

  // ===== DISCOVERY (2) =====

  registerTool(server, {
    name: 'board_summarize',
    description: 'Get a board summary grouped by frames, including element counts and text content. `id` accepts either a UUID or a board name.',
    input: {
      id: z.string().describe('Board UUID or name'),
    },
    returns: z.object({ data: z.array(elementShape.extend({ children: z.array(elementShape).optional() })) }),
    handler: async ({ id }) => {
      const resolvedId = await resolveBoardId(client, id);
      if (!resolvedId) {
        return err('summarizing board', {
          error: `Board not found: ${id}`,
        });
      }
      const result = await client.request('GET', `/boards/${resolvedId}/elements/frames`);
      if (!result.ok) return err('summarizing board', result.data);

      // Return the frames data as a structured summary
      return ok(result.data);
    },
  });

  registerTool(server, {
    name: 'board_search',
    description: 'Search across board element text content.',
    input: {
      query: z.string().max(500).describe('Search query (max 500 chars)'),
      project_id: z.string().uuid().optional().describe('Filter by project'),
    },
    returns: z.object({ data: z.array(z.object({ board_id: z.string().uuid(), element: elementShape }).passthrough()) }),
    handler: async (params) => {
      // The board-api search endpoint takes `q`, not `query`.
      const qs = buildQs({ q: params.query, project_id: params.project_id });
      const result = await client.request('GET', `/boards/search${qs}`);
      return result.ok ? ok(result.data) : err('searching boards', result.data);
    },
  });

  // ===== BOARD DISCOVERY — additional reads (3) =====

  registerTool(server, {
    name: 'board_list_recent',
    description: 'List the boards most recently updated by or visible to the caller.',
    input: {},
    returns: z.object({ data: z.array(boardShape) }).passthrough(),
    handler: async () => {
      const result = await client.request('GET', '/boards/recent');
      return result.ok ? ok(result.data) : err('listing recent boards', result.data);
    },
  });

  registerTool(server, {
    name: 'board_list_starred',
    description: 'List the boards the calling user has starred.',
    input: {},
    returns: z.object({ data: z.array(boardShape) }).passthrough(),
    handler: async () => {
      const result = await client.request('GET', '/boards/starred');
      return result.ok ? ok(result.data) : err('listing starred boards', result.data);
    },
  });

  registerTool(server, {
    name: 'board_org_stats',
    description: 'Get org-level board statistics (counts, activity rollups across all boards in the organization).',
    input: {},
    returns: z.object({ data: z.object({}).passthrough() }).passthrough(),
    handler: async () => {
      const result = await client.request('GET', '/boards/stats');
      return result.ok ? ok(result.data) : err('getting org board stats', result.data);
    },
  });

  registerTool(server, {
    name: 'board_stats',
    description: 'Get statistics for a single board (element counts, collaborator counts, last activity). `id` accepts either a UUID or a board name.',
    input: {
      id: z.string().describe('Board UUID or name'),
    },
    returns: z.object({ data: z.object({}).passthrough() }).passthrough(),
    handler: async ({ id }) => {
      const resolvedId = await resolveBoardId(client, id);
      if (!resolvedId) {
        return err('getting board stats', { error: `Board not found: ${id}` });
      }
      const result = await client.request('GET', `/boards/${resolvedId}/stats`);
      return result.ok ? ok(result.data) : err('getting board stats', result.data);
    },
  });

  // ===== BOARD LIFECYCLE — additional (5) =====

  registerTool(server, {
    name: 'board_duplicate',
    description: 'Duplicate a board, copying its elements into a new board. `id` accepts either a UUID or a board name.',
    input: {
      id: z.string().describe('Board UUID or name to duplicate'),
    },
    returns: boardShape,
    handler: async ({ id }) => {
      const resolvedId = await resolveBoardId(client, id);
      if (!resolvedId) {
        return err('duplicating board', { error: `Board not found: ${id}` });
      }
      const result = await client.request('POST', `/boards/${resolvedId}/duplicate`);
      return result.ok ? ok(result.data) : err('duplicating board', result.data);
    },
  });

  registerTool(server, {
    name: 'board_restore',
    description: 'Restore a previously archived board. `id` accepts either a UUID or a board name.',
    input: {
      id: z.string().describe('Board UUID or name'),
    },
    returns: boardShape,
    handler: async ({ id }) => {
      const resolvedId = await resolveBoardId(client, id);
      if (!resolvedId) {
        return err('restoring board', { error: `Board not found: ${id}` });
      }
      const result = await client.request('POST', `/boards/${resolvedId}/restore`);
      return result.ok ? ok(result.data) : err('restoring board', result.data);
    },
  });

  registerTool(server, {
    name: 'board_delete_permanent',
    description: 'Permanently hard-delete a board and ALL of its elements, collaborators, stars, and versions (cascade). This is irreversible — distinct from board_archive which only soft-deletes. `id` accepts either a UUID or a board name.',
    input: {
      id: z.string().describe('Board UUID or name to permanently delete'),
    },
    returns: z.object({ data: z.object({}).passthrough() }).passthrough(),
    handler: async ({ id }) => {
      const resolvedId = await resolveBoardId(client, id);
      if (!resolvedId) {
        return err('permanently deleting board', { error: `Board not found: ${id}` });
      }
      const result = await client.request('DELETE', `/boards/${resolvedId}/permanent`);
      return result.ok ? ok(result.data) : err('permanently deleting board', result.data);
    },
  });

  registerTool(server, {
    name: 'board_star_toggle',
    description: 'Toggle the calling user\'s star on a board (favorite / unfavorite). `id` accepts either a UUID or a board name.',
    input: {
      id: z.string().describe('Board UUID or name'),
    },
    returns: z.object({ data: z.object({ starred: z.boolean().optional() }).passthrough() }).passthrough(),
    handler: async ({ id }) => {
      const resolvedId = await resolveBoardId(client, id);
      if (!resolvedId) {
        return err('toggling board star', { error: `Board not found: ${id}` });
      }
      const result = await client.request('POST', `/boards/${resolvedId}/star`);
      return result.ok ? ok(result.data) : err('toggling board star', result.data);
    },
  });

  // ===== BOARD INTEGRITY (2) =====

  registerTool(server, {
    name: 'board_check_integrity',
    description: 'Run a per-board integrity check, returning the list of structural issues (e.g. a project_id referencing a project outside the org). `id` accepts either a UUID or a board name.',
    input: {
      id: z.string().describe('Board UUID or name'),
    },
    returns: z.object({ data: z.object({ issues: z.array(z.object({}).passthrough()), ok: z.boolean() }).passthrough() }),
    handler: async ({ id }) => {
      const resolvedId = await resolveBoardId(client, id);
      if (!resolvedId) {
        return err('checking board integrity', { error: `Board not found: ${id}` });
      }
      const result = await client.request('GET', `/boards/${resolvedId}/integrity`);
      return result.ok ? ok(result.data) : err('checking board integrity', result.data);
    },
  });

  registerTool(server, {
    name: 'board_remediate_integrity',
    description: 'Apply a fix for a board integrity issue: "detach" clears the board\'s project association, "reassign" moves it to a different project (which must belong to the caller\'s org). `id` accepts a board UUID or name; for "reassign", `project_id` accepts a project UUID or project name.',
    input: {
      id: z.string().describe('Board UUID or name'),
      action: z.enum(['detach', 'reassign']).describe('Remediation action to apply'),
      project_id: z.string().optional().describe('Target project UUID or name (required for "reassign")'),
    },
    returns: z.object({ data: boardShape }),
    handler: async ({ id, action, project_id }) => {
      const resolvedId = await resolveBoardId(client, id);
      if (!resolvedId) {
        return err('remediating board integrity', { error: `Board not found: ${id}` });
      }
      let body: Record<string, unknown>;
      if (action === 'reassign') {
        if (!project_id) {
          return err('remediating board integrity', {
            error: 'project_id is required when action is "reassign"',
          });
        }
        const resolvedProjectId = await resolveProjectId(api, project_id);
        if (!resolvedProjectId) {
          return err('remediating board integrity', {
            error: `Project not found: ${project_id}`,
          });
        }
        body = { action: 'reassign', project_id: resolvedProjectId };
      } else {
        body = { action: 'detach' };
      }
      const result = await client.request('POST', `/boards/${resolvedId}/remediate`, body);
      return result.ok ? ok(result.data) : err('remediating board integrity', result.data);
    },
  });

  // ===== BOARD CHAT (2) =====

  registerTool(server, {
    name: 'board_read_chat',
    description: 'Read the recent chat messages on a board (most recent first, capped server-side). `id` accepts either a UUID or a board name.',
    input: {
      id: z.string().describe('Board UUID or name'),
    },
    returns: z.object({ data: z.array(z.object({ id: z.string().uuid(), user_id: z.string().uuid(), body: z.string(), created_at: z.string() }).passthrough()) }),
    handler: async ({ id }) => {
      const resolvedId = await resolveBoardId(client, id);
      if (!resolvedId) {
        return err('reading board chat', { error: `Board not found: ${id}` });
      }
      const result = await client.request('GET', `/boards/${resolvedId}/chat`);
      return result.ok ? ok(result.data) : err('reading board chat', result.data);
    },
  });

  registerTool(server, {
    name: 'board_post_chat',
    description: 'Post a chat message into a board\'s side-channel chat. `board_id` accepts either a UUID or a board name.',
    input: {
      board_id: z.string().describe('Board UUID or name'),
      body: z.string().min(1).max(5000).describe('Message text (max 5000 chars)'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), body: z.string(), created_at: z.string() }).passthrough() }),
    handler: async ({ board_id, body }) => {
      const resolvedBoardId = await resolveBoardId(client, board_id);
      if (!resolvedBoardId) {
        return err('posting board chat', { error: `Board not found: ${board_id}` });
      }
      const result = await client.request('POST', `/boards/${resolvedBoardId}/chat`, { body });
      return result.ok ? ok(result.data) : err('posting board chat', result.data);
    },
  });

  // ===== COLLABORATORS (4) =====

  registerTool(server, {
    name: 'board_list_collaborators',
    description: 'List the collaborators (and their view/edit permission) on a board. `id` accepts either a UUID or a board name.',
    input: {
      id: z.string().describe('Board UUID or name'),
    },
    returns: z.object({ data: z.array(z.object({ id: z.string().uuid(), board_id: z.string().uuid(), user_id: z.string().uuid(), permission: z.string() }).passthrough()) }),
    handler: async ({ id }) => {
      const resolvedId = await resolveBoardId(client, id);
      if (!resolvedId) {
        return err('listing board collaborators', { error: `Board not found: ${id}` });
      }
      const result = await client.request('GET', `/boards/${resolvedId}/collaborators`);
      return result.ok ? ok(result.data) : err('listing board collaborators', result.data);
    },
  });

  registerTool(server, {
    name: 'board_add_collaborator',
    description: 'Add a collaborator to a board with a view or edit permission. `board_id` accepts a UUID or board name; `user_id` accepts a user UUID or email address.',
    input: {
      board_id: z.string().describe('Board UUID or name'),
      user_id: z.string().describe('Collaborator: user UUID or email address'),
      permission: z.enum(['view', 'edit']).optional().describe('Permission level (default edit)'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), board_id: z.string().uuid(), user_id: z.string().uuid(), permission: z.string() }).passthrough() }),
    handler: async ({ board_id, user_id, permission }) => {
      const resolvedBoardId = await resolveBoardId(client, board_id);
      if (!resolvedBoardId) {
        return err('adding board collaborator', { error: `Board not found: ${board_id}` });
      }
      const resolvedUserId = await resolveUserId(api, user_id);
      if (!resolvedUserId) {
        return err('adding board collaborator', { error: `User not found by email or id: ${user_id}` });
      }
      const body: Record<string, unknown> = { user_id: resolvedUserId };
      if (permission !== undefined) body.permission = permission;
      const result = await client.request('POST', `/boards/${resolvedBoardId}/collaborators`, body);
      return result.ok ? ok(result.data) : err('adding board collaborator', result.data);
    },
  });

  registerTool(server, {
    name: 'board_update_collaborator',
    description: 'Change a collaborator\'s permission (view or edit) on a board. `collaborator_id` is the collaborator-row UUID (get it from board_list_collaborators).',
    input: {
      collaborator_id: z.string().uuid().describe('Collaborator row UUID (from board_list_collaborators)'),
      permission: z.enum(['view', 'edit']).describe('New permission level'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), permission: z.string() }).passthrough() }),
    handler: async ({ collaborator_id, permission }) => {
      const result = await client.request('PATCH', `/collaborators/${collaborator_id}`, { permission });
      return result.ok ? ok(result.data) : err('updating board collaborator', result.data);
    },
  });

  registerTool(server, {
    name: 'board_remove_collaborator',
    description: 'Remove a collaborator from a board. `collaborator_id` is the collaborator-row UUID (get it from board_list_collaborators).',
    input: {
      collaborator_id: z.string().uuid().describe('Collaborator row UUID (from board_list_collaborators)'),
    },
    returns: z.object({ removed: z.literal(true), collaborator_id: z.string().uuid() }),
    handler: async ({ collaborator_id }) => {
      const result = await client.request('DELETE', `/collaborators/${collaborator_id}`);
      return result.ok
        ? ok({ removed: true, collaborator_id })
        : err('removing board collaborator', result.data);
    },
  });

  // ===== ELEMENT-TASK LINKS (2) =====

  registerTool(server, {
    name: 'board_list_links',
    description: 'List the element-to-Bam-task links on a board (created when stickies are promoted to tasks). `id` accepts either a UUID or a board name.',
    input: {
      id: z.string().describe('Board UUID or name'),
    },
    returns: z.object({ data: z.array(z.object({ id: z.string().uuid(), board_id: z.string().uuid(), element_id: z.string(), task_id: z.string().uuid() }).passthrough()) }),
    handler: async ({ id }) => {
      const resolvedId = await resolveBoardId(client, id);
      if (!resolvedId) {
        return err('listing board links', { error: `Board not found: ${id}` });
      }
      const result = await client.request('GET', `/boards/${resolvedId}/links`);
      return result.ok ? ok(result.data) : err('listing board links', result.data);
    },
  });

  registerTool(server, {
    name: 'board_delete_link',
    description: 'Delete a single element-to-task link by its link UUID (get it from board_list_links). This does not delete the underlying task or element, only the association.',
    input: {
      link_id: z.string().uuid().describe('Link row UUID (from board_list_links)'),
    },
    returns: z.object({ removed: z.literal(true), link_id: z.string().uuid() }),
    handler: async ({ link_id }) => {
      const result = await client.request('DELETE', `/links/${link_id}`);
      return result.ok
        ? ok({ removed: true, link_id })
        : err('deleting board link', result.data);
    },
  });

  // ===== VERSIONS (3) =====

  registerTool(server, {
    name: 'board_list_versions',
    description: 'List the saved version snapshots of a board. `id` accepts either a UUID or a board name.',
    input: {
      id: z.string().describe('Board UUID or name'),
    },
    returns: z.object({ data: z.array(z.object({ id: z.string().uuid(), board_id: z.string().uuid(), name: z.string().nullable().optional(), created_at: z.string() }).passthrough()) }),
    handler: async ({ id }) => {
      const resolvedId = await resolveBoardId(client, id);
      if (!resolvedId) {
        return err('listing board versions', { error: `Board not found: ${id}` });
      }
      const result = await client.request('GET', `/boards/${resolvedId}/versions`);
      return result.ok ? ok(result.data) : err('listing board versions', result.data);
    },
  });

  registerTool(server, {
    name: 'board_create_version',
    description: 'Capture a named snapshot of a board\'s current scene that can later be restored. `board_id` accepts either a UUID or a board name.',
    input: {
      board_id: z.string().describe('Board UUID or name'),
      name: z.string().min(1).max(255).optional().describe('Optional snapshot label'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), board_id: z.string().uuid(), name: z.string().nullable().optional(), created_at: z.string() }).passthrough() }),
    handler: async ({ board_id, name }) => {
      const resolvedBoardId = await resolveBoardId(client, board_id);
      if (!resolvedBoardId) {
        return err('creating board version', { error: `Board not found: ${board_id}` });
      }
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      const result = await client.request('POST', `/boards/${resolvedBoardId}/versions`, body);
      return result.ok ? ok(result.data) : err('creating board version', result.data);
    },
  });

  registerTool(server, {
    name: 'board_restore_version',
    description: 'Restore a board to a previously captured version snapshot, replacing its current scene. `board_id` accepts a UUID or board name; `version_id` is the version UUID (get it from board_list_versions).',
    input: {
      board_id: z.string().describe('Board UUID or name'),
      version_id: z.string().uuid().describe('Version snapshot UUID (from board_list_versions)'),
    },
    returns: z.object({ data: boardShape }),
    handler: async ({ board_id, version_id }) => {
      const resolvedBoardId = await resolveBoardId(client, board_id);
      if (!resolvedBoardId) {
        return err('restoring board version', { error: `Board not found: ${board_id}` });
      }
      const result = await client.request('POST', `/boards/${resolvedBoardId}/versions/${version_id}/restore`);
      return result.ok ? ok(result.data) : err('restoring board version', result.data);
    },
  });

  // ===== TEMPLATES (5) =====

  registerTool(server, {
    name: 'board_list_templates',
    description: 'List the board templates available to the org (system + org-defined), optionally filtered by category.',
    input: {
      category: z.string().max(100).optional().describe('Filter by template category'),
    },
    returns: z.object({ data: z.array(z.object({ id: z.string().uuid(), name: z.string(), category: z.string().nullable().optional() }).passthrough()) }),
    handler: async (params) => {
      const result = await client.request('GET', `/templates${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing board templates', result.data);
    },
  });

  registerTool(server, {
    name: 'board_create_template',
    description: 'Create a board template, optionally seeded from an existing board\'s scene. `board_id` (if provided) accepts a UUID or a board name to capture as the template.',
    input: {
      name: z.string().min(1).max(255).describe('Template name'),
      description: z.string().max(2000).optional().describe('Template description'),
      category: z.string().max(100).optional().describe('Template category'),
      icon: z.string().max(10).optional().describe('Template icon (short string / emoji)'),
      board_id: z.string().optional().describe('Source board UUID or name to capture the template scene from'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), name: z.string() }).passthrough() }),
    handler: async ({ board_id, ...rest }) => {
      const body: Record<string, unknown> = { ...rest };
      if (board_id !== undefined) {
        const resolvedBoardId = await resolveBoardId(client, board_id);
        if (!resolvedBoardId) {
          return err('creating board template', { error: `Board not found: ${board_id}` });
        }
        body.board_id = resolvedBoardId;
      }
      const result = await client.request('POST', '/templates', body);
      return result.ok ? ok(result.data) : err('creating board template', result.data);
    },
  });

  registerTool(server, {
    name: 'board_update_template',
    description: 'Update a board template\'s metadata. `id` accepts either a UUID or a template name. Provide only the fields to change.',
    input: {
      id: z.string().describe('Template UUID or name'),
      name: z.string().min(1).max(255).optional().describe('Updated name'),
      description: z.string().max(2000).optional().describe('Updated description'),
      category: z.string().max(100).optional().describe('Updated category'),
      icon: z.string().max(10).optional().describe('Updated icon'),
      sort_order: z.number().int().min(0).max(10000).optional().describe('Updated sort order'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), name: z.string() }).passthrough() }),
    handler: async ({ id, ...rest }) => {
      const resolvedId = await resolveTemplateId(client, id);
      if (!resolvedId) {
        return err('updating board template', { error: `Template not found: ${id}` });
      }
      const result = await client.request('PATCH', `/templates/${resolvedId}`, rest);
      return result.ok ? ok(result.data) : err('updating board template', result.data);
    },
  });

  registerTool(server, {
    name: 'board_delete_template',
    description: 'Delete a board template. `id` accepts either a UUID or a template name.',
    input: {
      id: z.string().describe('Template UUID or name'),
    },
    returns: z.object({ deleted: z.literal(true), id: z.string().uuid() }),
    handler: async ({ id }) => {
      const resolvedId = await resolveTemplateId(client, id);
      if (!resolvedId) {
        return err('deleting board template', { error: `Template not found: ${id}` });
      }
      const result = await client.request('DELETE', `/templates/${resolvedId}`);
      return result.ok ? ok({ deleted: true, id: resolvedId }) : err('deleting board template', result.data);
    },
  });

  registerTool(server, {
    name: 'board_instantiate_template',
    description: 'Create a new board from a template. `id` accepts a template UUID or name; `project_id` (if provided) accepts a project UUID or name to associate the new board with.',
    input: {
      id: z.string().describe('Template UUID or name'),
      name: z.string().min(1).max(255).optional().describe('Name for the new board (defaults to the template name)'),
      project_id: z.string().optional().describe('Project UUID or name to associate the new board with'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), name: z.string() }).passthrough() }),
    handler: async ({ id, name, project_id }) => {
      const resolvedId = await resolveTemplateId(client, id);
      if (!resolvedId) {
        return err('instantiating board template', { error: `Template not found: ${id}` });
      }
      const body: Record<string, unknown> = {};
      if (name !== undefined) body.name = name;
      if (project_id !== undefined) {
        const resolvedProjectId = await resolveProjectId(api, project_id);
        if (!resolvedProjectId) {
          return err('instantiating board template', { error: `Project not found: ${project_id}` });
        }
        body.project_id = resolvedProjectId;
      }
      const result = await client.request('POST', `/templates/${resolvedId}/instantiate`, body);
      return result.ok ? ok(result.data) : err('instantiating board template', result.data);
    },
  });
}
