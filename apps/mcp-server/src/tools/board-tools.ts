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
      const result = await client.request('GET', `/boards/search${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('searching boards', result.data);
    },
  });
}
