import { registerTool } from '../lib/register-tool.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';

/**
 * Blueprint MCP tools. Blueprint is BigBlueBam's structured-diagram product:
 * unlike Board's freeform whiteboard, every Blueprint diagram is a typed graph
 * (nodes, edges, ports) backed by relational tables, so every structural
 * mutation is an auditable API call and an agent can build or rewrite a
 * diagram as a first-class user with the same permissions and audit trail as
 * a human.
 *
 * Follows the same pattern as board-tools.ts and bench-tools.ts: a small
 * fetch wrapper that forwards the user's bearer token from the main ApiClient,
 * a `createBlueprintClient` factory, and per-tool `registerTool(...)` calls.
 *
 * Destructive tools (`blueprint_archive`, `blueprint_delete_node`,
 * `blueprint_delete_edge`) use the per-tool boolean `confirm_action` flag
 * pattern shared with banter_delete_channel and platform_delete_org: call
 * once with `confirm_action: false` (or omit) to preview, then call again
 * with `confirm_action: true` to actually proceed.
 */
function createBlueprintClient(blueprintApiUrl: string, api: ApiClient) {
  const baseUrl = blueprintApiUrl.replace(/\/$/, '');

  async function request(method: string, path: string, body?: unknown) {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {};

    // Forward the bearer token from the main API client. ApiClient holds the
    // token in a private field; the rest of the MCP tools cast through
    // `unknown` to read it, so this stays consistent across modules.
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
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  }

  return { request };
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

const diagramShape = z.object({
  id: z.string().uuid(),
  org_id: z.string().uuid().optional(),
  project_id: z.string().uuid().nullable().optional(),
  name: z.string(),
  description: z.string().nullable().optional(),
  diagram_type: z.string().optional(),
  layout_algorithm: z.string().optional(),
  visibility: z.string().optional(),
  is_archived: z.boolean().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

const nodeShape = z.object({
  id: z.string().uuid(),
  diagram_id: z.string().uuid().optional(),
  shape: z.string().optional(),
  label: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  parent_node_id: z.string().uuid().nullable().optional(),
  position_x: z.number().optional(),
  position_y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  z_index: z.number().optional(),
  pinned: z.boolean().optional(),
  style: z.record(z.unknown()).nullable().optional(),
  data: z.record(z.unknown()).nullable().optional(),
  ref_entity_type: z.string().nullable().optional(),
  ref_entity_id: z.string().uuid().nullable().optional(),
}).passthrough();

const edgeShape = z.object({
  id: z.string().uuid(),
  diagram_id: z.string().uuid().optional(),
  source_node_id: z.string().uuid(),
  target_node_id: z.string().uuid(),
  source_handle: z.string().nullable().optional(),
  target_handle: z.string().nullable().optional(),
  kind: z.string().optional(),
  label: z.string().nullable().optional(),
  marker_start: z.string().optional(),
  marker_end: z.string().optional(),
  style: z.record(z.unknown()).nullable().optional(),
  waypoints: z.array(z.object({ x: z.number(), y: z.number() })).nullable().optional(),
}).passthrough();

export function registerBlueprintTools(
  server: McpServer,
  api: ApiClient,
  blueprintApiUrl: string,
): void {
  const client = createBlueprintClient(blueprintApiUrl, api);

  // ===== DIAGRAM READ (5) =====

  registerTool(server, {
    name: 'blueprint_list',
    description:
      'List Blueprint diagrams visible to the caller, optionally filtered by project, diagram type, starred-by-me, or include-archived. Blueprint diagrams are typed graphs (nodes, edges, ports) backed by relational tables — distinct from Board (freeform whiteboard). Returns metadata only; use blueprint_get / blueprint_read_nodes / blueprint_read_edges for the graph payload.',
    input: {
      project_id: z.string().uuid().optional().describe('Filter by project'),
      diagram_type: z.string().optional().describe('Filter by diagram type (e.g., "flowchart", "orgchart", "swimlane")'),
      starred: z.boolean().optional().describe('If true, only diagrams the caller has starred'),
      include_archived: z.boolean().optional().describe('Include archived diagrams (default false)'),
    },
    returns: z.object({ data: z.array(diagramShape) }),
    handler: async (params) => {
      const result = await client.request('GET', `/diagrams${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing blueprint diagrams', result.data);
    },
  });

  registerTool(server, {
    name: 'blueprint_get',
    description:
      "Get a Blueprint diagram's metadata, type, layout algorithm, visibility, and timestamps. Returns the diagram envelope only; use blueprint_read_nodes / blueprint_read_edges for the graph payload.",
    input: {
      id: z.string().uuid().describe('Diagram ID'),
    },
    returns: diagramShape,
    handler: async ({ id }) => {
      const result = await client.request('GET', `/diagrams/${id}`);
      return result.ok ? ok(result.data) : err('getting blueprint diagram', result.data);
    },
  });

  registerTool(server, {
    name: 'blueprint_read_nodes',
    description:
      'Read every node in a Blueprint diagram. Returns full node rows with positions, sizes, parent_node_id (for container nesting), style/data JSONB, and any cross-product ref_entity_type / ref_entity_id linkage (e.g. bam.task, beacon.entry, bond.deal). Use this together with blueprint_read_edges to reconstruct the full graph payload.',
    input: {
      id: z.string().uuid().describe('Diagram ID'),
    },
    returns: z.object({ data: z.array(nodeShape) }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/diagrams/${id}/nodes`);
      return result.ok ? ok(result.data) : err('reading blueprint nodes', result.data);
    },
  });

  registerTool(server, {
    name: 'blueprint_read_edges',
    description:
      "Read every edge in a Blueprint diagram. Edges connect nodes by uuid (source_node_id, target_node_id) and carry kind, label, markers, style, and optional waypoints for routed paths. Pair with blueprint_read_nodes to materialize the graph.",
    input: {
      id: z.string().uuid().describe('Diagram ID'),
    },
    returns: z.object({ data: z.array(edgeShape) }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/diagrams/${id}/edges`);
      return result.ok ? ok(result.data) : err('reading blueprint edges', result.data);
    },
  });

  registerTool(server, {
    name: 'blueprint_search',
    description:
      'Search Blueprint diagrams by case-insensitive substring on name and description. NOTE (MVP limitation): the blueprint-api does not yet expose a server-side search filter, so this tool fetches the visible diagram list and filters client-side. Result counts are capped by the visible list size and node-label search is not yet supported. The Wave 5 plan upgrades this to a server-side ILIKE + node-label search; until then, prefer blueprint_list with project_id / diagram_type filters when you know them.',
    input: {
      query: z.string().min(1).max(500).describe('Substring to match against name and description'),
      project_id: z.string().uuid().optional().describe('Optional project scope to narrow the candidate list'),
      include_archived: z.boolean().optional().describe('Include archived diagrams in the candidate list (default false)'),
    },
    returns: z.object({ data: z.array(diagramShape), total_candidates: z.number().int().nonnegative() }),
    handler: async ({ query, project_id, include_archived }) => {
      const listParams: Record<string, unknown> = {};
      if (project_id) listParams.project_id = project_id;
      if (include_archived) listParams.include_archived = include_archived;
      const result = await client.request('GET', `/diagrams${buildQs(listParams)}`);
      if (!result.ok) return err('searching blueprint diagrams', result.data);
      const envelope = result.data as { data?: Array<Record<string, unknown>> } | null;
      const rows = envelope?.data ?? [];
      const needle = query.toLowerCase();
      const filtered = rows.filter((r) => {
        const name = typeof r.name === 'string' ? r.name.toLowerCase() : '';
        const description = typeof r.description === 'string' ? r.description.toLowerCase() : '';
        return name.includes(needle) || description.includes(needle);
      });
      return ok({ data: filtered, total_candidates: rows.length });
    },
  });

  registerTool(server, {
    name: 'blueprint_export',
    description:
      "Export a Blueprint diagram in the requested format. `json` is the canonical structured payload; `mermaid` produces a Mermaid source string useful for re-embedding in Briefs or LLM context; `svg` and `png` produce rendered artifacts (large graphs may be queued via a worker job — the response surfaces whatever the api returns).",
    input: {
      id: z.string().uuid().describe('Diagram ID'),
      format: z.enum(['json', 'mermaid', 'svg', 'png']).describe('Export format'),
    },
    returns: z.object({ data: z.unknown() }).passthrough(),
    handler: async ({ id, format }) => {
      const result = await client.request('GET', `/diagrams/${id}/export?format=${encodeURIComponent(format)}`);
      return result.ok ? ok(result.data) : err('exporting blueprint diagram', result.data);
    },
  });

  // ===== DIAGRAM WRITE (3) =====

  registerTool(server, {
    name: 'blueprint_create',
    description:
      'Create a new Blueprint diagram. `diagram_type` is a free-form tag (e.g. "flowchart", "orgchart", "swimlane", "architecture") that the UI uses to pick the default shape palette and layout. `layout_algorithm` defaults to ELK `layered`; other values include `mrtree` (org charts), `force`, and `radial`. `template_id` initializes the diagram from an existing template.',
    input: {
      name: z.string().min(1).max(200).describe('Diagram name (max 200 chars)'),
      description: z.string().max(5000).optional().describe('Optional description (max 5000 chars)'),
      project_id: z.string().uuid().nullable().optional().describe('Project to associate the diagram with (null for org-wide)'),
      diagram_type: z.string().max(32).optional().describe('Free-form diagram type tag (e.g., "flowchart", "orgchart")'),
      layout_algorithm: z.string().max(32).optional().describe('ELK layout algorithm name (e.g., "layered", "mrtree", "force")'),
      visibility: z.enum(['organization', 'project', 'private']).optional().describe('Visibility level (default private)'),
      layout_options: z.record(z.unknown()).optional().describe('Layout-specific options passed to ELK (e.g., direction, spacing)'),
      canvas_settings: z.record(z.unknown()).optional().describe('Canvas appearance settings (background, grid, etc.)'),
      template_id: z.string().uuid().optional().describe('Template UUID to seed the new diagram from'),
    },
    returns: z.object({ data: diagramShape }),
    handler: async (params) => {
      const result = await client.request('POST', '/diagrams', params);
      return result.ok ? ok(result.data) : err('creating blueprint diagram', result.data);
    },
  });

  registerTool(server, {
    name: 'blueprint_update',
    description:
      "Update a Blueprint diagram's metadata. Provide only the fields to change. Concurrent edits use last-write-wins with an updated_at stale check at the api layer.",
    input: {
      id: z.string().uuid().describe('Diagram ID'),
      name: z.string().min(1).max(200).optional().describe('Updated name'),
      description: z.string().max(5000).nullable().optional().describe('Updated description (null to clear)'),
      project_id: z.string().uuid().nullable().optional().describe('Reassign to a different project (null for org-wide)'),
      diagram_type: z.string().max(32).optional().describe('Updated diagram type tag'),
      layout_algorithm: z.string().max(32).optional().describe('Updated ELK layout algorithm name'),
      visibility: z.enum(['organization', 'project', 'private']).optional().describe('Updated visibility'),
      layout_options: z.record(z.unknown()).optional().describe('Updated layout options'),
      canvas_settings: z.record(z.unknown()).optional().describe('Updated canvas settings'),
    },
    returns: z.object({ data: diagramShape }),
    handler: async ({ id, ...body }) => {
      const result = await client.request('PATCH', `/diagrams/${id}`, body);
      return result.ok ? ok(result.data) : err('updating blueprint diagram', result.data);
    },
  });

  registerTool(server, {
    name: 'blueprint_archive',
    description:
      "Archive a Blueprint diagram (soft delete — sets is_archived=true on blueprint_diagrams). Destructive — requires confirm_action=true to actually proceed. Call once with confirm_action: false (or omit) to preview the action, then call again with confirm_action: true to commit. Requires the caller's API key scope to include `admin`.",
    input: {
      id: z.string().uuid().describe('Diagram ID to archive'),
      confirm_action: z.boolean().describe('Must be true to actually archive. Call once with false (or omit) to preview the action, then call again with true.'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), is_archived: z.boolean() }) }),
    handler: async ({ id, confirm_action }) => {
      if (!confirm_action) {
        return {
          content: [{
            type: 'text' as const,
            text: `Are you sure you want to archive Blueprint diagram ${id}? This is a soft delete; the diagram is hidden from default lists but its nodes, edges, and version history are preserved. Call blueprint_archive again with confirm_action: true to proceed.`,
          }],
        };
      }
      const result = await client.request('POST', `/diagrams/${id}/archive`);
      return result.ok ? ok(result.data) : err('archiving blueprint diagram', result.data);
    },
  });

  // ===== NODE OPERATIONS (4) =====

  registerTool(server, {
    name: 'blueprint_add_node',
    description:
      "Add a node to a Blueprint diagram. `shape` is a free-form tag the renderer maps to a visual (e.g. 'rounded', 'rectangle', 'diamond', 'circle', 'cylinder', 'subroutine', 'actor'). Set `parent_node_id` to nest the node inside a container/swimlane. Set `ref_entity_type` + `ref_entity_id` to back-link the node to a cross-product entity (e.g. ref_entity_type='bam.task', ref_entity_id=<task uuid>). Positions are optional — if omitted, blueprint_apply_layout will place the node.",
    input: {
      id: z.string().uuid().describe('Diagram ID'),
      shape: z.string().max(32).optional().describe('Shape tag (e.g., "rounded", "diamond", "circle")'),
      label: z.string().max(2000).optional().describe('Visible label text'),
      description: z.string().max(10000).optional().describe('Long-form description shown in the node detail pane'),
      parent_node_id: z.string().uuid().nullable().optional().describe('Parent container node for nesting (null for top-level)'),
      position_x: z.number().optional().describe('X position (px) — optional; auto-layout will place if omitted'),
      position_y: z.number().optional().describe('Y position (px) — optional; auto-layout will place if omitted'),
      width: z.number().positive().max(5000).optional().describe('Node width (px)'),
      height: z.number().positive().max(5000).optional().describe('Node height (px)'),
      z_index: z.number().int().optional().describe('Stacking order (higher = on top)'),
      pinned: z.boolean().optional().describe('If true, the node is pinned against auto-layout reshuffles'),
      style: z.record(z.unknown()).optional().describe('Style overrides JSON (colors, borders, etc.)'),
      data: z.record(z.unknown()).optional().describe('Arbitrary structured data attached to the node'),
      ref_entity_type: z.string().max(32).nullable().optional().describe('Cross-product link type (e.g., "bam.task", "beacon.entry", "bond.deal")'),
      ref_entity_id: z.string().uuid().nullable().optional().describe('Cross-product entity UUID matching ref_entity_type'),
    },
    returns: z.object({ data: nodeShape }),
    handler: async ({ id, ...body }) => {
      const result = await client.request('POST', `/diagrams/${id}/nodes`, body);
      return result.ok ? ok(result.data) : err('adding blueprint node', result.data);
    },
  });

  registerTool(server, {
    name: 'blueprint_update_node',
    description:
      "Update fields on a Blueprint node. Provide only the fields to change. Does NOT update position — use blueprint_move_node for that. To re-target the cross-product link, prefer blueprint_link_entity (single-purpose tool with cleaner semantics).",
    input: {
      id: z.string().uuid().describe('Diagram ID'),
      node_id: z.string().uuid().describe('Node ID'),
      shape: z.string().max(32).optional().describe('Updated shape tag'),
      label: z.string().max(2000).optional().describe('Updated label'),
      description: z.string().max(10000).nullable().optional().describe('Updated description (null to clear)'),
      parent_node_id: z.string().uuid().nullable().optional().describe('Updated parent container (null to detach)'),
      width: z.number().positive().max(5000).optional().describe('Updated width (px)'),
      height: z.number().positive().max(5000).optional().describe('Updated height (px)'),
      z_index: z.number().int().optional().describe('Updated stacking order'),
      pinned: z.boolean().optional().describe('Updated pin state'),
      style: z.record(z.unknown()).optional().describe('Updated style JSON'),
      data: z.record(z.unknown()).optional().describe('Updated data JSON'),
      ref_entity_type: z.string().max(32).nullable().optional().describe('Updated cross-product link type'),
      ref_entity_id: z.string().uuid().nullable().optional().describe('Updated cross-product entity UUID'),
    },
    returns: z.object({ data: nodeShape }),
    handler: async ({ id, node_id, ...body }) => {
      const result = await client.request('PATCH', `/diagrams/${id}/nodes/${node_id}`, body);
      return result.ok ? ok(result.data) : err('updating blueprint node', result.data);
    },
  });

  registerTool(server, {
    name: 'blueprint_move_node',
    description:
      "Reposition a Blueprint node to a specific (position_x, position_y). Optionally pin the node against future auto-layout passes by setting pinned=true. Broadcasts a blueprint.node.moved event over WebSocket so collaborators see the move live.",
    input: {
      id: z.string().uuid().describe('Diagram ID'),
      node_id: z.string().uuid().describe('Node ID'),
      position_x: z.number().describe('New X position (px)'),
      position_y: z.number().describe('New Y position (px)'),
      pinned: z.boolean().optional().describe('If true, pin the node so future auto-layout passes leave it in place'),
    },
    returns: z.object({ data: nodeShape }),
    handler: async ({ id, node_id, ...body }) => {
      const result = await client.request('POST', `/diagrams/${id}/nodes/${node_id}/move`, body);
      return result.ok ? ok(result.data) : err('moving blueprint node', result.data);
    },
  });

  registerTool(server, {
    name: 'blueprint_duplicate_node',
    description:
      "Duplicate a Blueprint node in the same diagram. The clone copies every visual attribute (label, shape, dimensions, style, data, cross-product entity ref) and is offset from the original so it doesn't sit on top of it — defaults to +32px down-right. Containment (parent_node_id), pinned state, and z-index are preserved. Edges to/from the source are NOT duplicated; connect the clone yourself if you need it wired in. Broadcasts a blueprint.node.created event.",
    input: {
      id: z.string().uuid().describe('Diagram ID'),
      node_id: z.string().uuid().describe('Node to duplicate'),
      offset_x: z.number().min(-2000).max(2000).optional().describe('Horizontal offset for the clone (default 32px)'),
      offset_y: z.number().min(-2000).max(2000).optional().describe('Vertical offset for the clone (default 32px)'),
    },
    returns: z.object({ data: nodeShape }),
    handler: async ({ id, node_id, ...body }) => {
      const result = await client.request('POST', `/diagrams/${id}/nodes/${node_id}/duplicate`, body);
      return result.ok ? ok(result.data) : err('duplicating blueprint node', result.data);
    },
  });

  registerTool(server, {
    name: 'blueprint_delete_node',
    description:
      "Delete a node from a Blueprint diagram. CASCADE-deletes every edge that references the node as source or target. Destructive — requires confirm_action=true to actually proceed. Call once with confirm_action: false (or omit) to preview, then call again with true to commit.",
    input: {
      id: z.string().uuid().describe('Diagram ID'),
      node_id: z.string().uuid().describe('Node ID to delete'),
      confirm_action: z.boolean().describe('Must be true to actually delete. Call once with false (or omit) to preview the action, then call again with true.'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), deleted: z.boolean() }) }).passthrough(),
    handler: async ({ id, node_id, confirm_action }) => {
      if (!confirm_action) {
        return {
          content: [{
            type: 'text' as const,
            text: `Are you sure you want to delete node ${node_id} from Blueprint diagram ${id}? This CASCADE-deletes every edge connected to the node. Call blueprint_delete_node again with confirm_action: true to proceed.`,
          }],
        };
      }
      const result = await client.request('DELETE', `/diagrams/${id}/nodes/${node_id}`);
      return result.ok ? ok(result.data) : err('deleting blueprint node', result.data);
    },
  });

  // ===== EDGE OPERATIONS (3) =====

  registerTool(server, {
    name: 'blueprint_add_edge',
    description:
      "Connect two Blueprint nodes with an edge. `kind` is a free-form tag the renderer uses to pick line style (e.g. 'sequence', 'reports_to', 'depends_on', 'data_flow'). source_handle / target_handle attach to specific connection points on the nodes (port ids); omit for default center-to-center connections. `marker_start` / `marker_end` control arrowheads ('arrow', 'circle', 'diamond', 'none'). Optional waypoints route the edge through specific (x, y) coordinates.",
    input: {
      id: z.string().uuid().describe('Diagram ID'),
      source_node_id: z.string().uuid().describe('Source node UUID'),
      target_node_id: z.string().uuid().describe('Target node UUID'),
      source_handle: z.string().max(64).nullable().optional().describe('Source port/handle id'),
      target_handle: z.string().max(64).nullable().optional().describe('Target port/handle id'),
      kind: z.string().max(32).optional().describe('Edge kind tag (e.g., "reports_to", "depends_on", "data_flow")'),
      label: z.string().max(2000).nullable().optional().describe('Visible edge label'),
      marker_start: z.string().max(16).optional().describe('Start marker (e.g., "arrow", "circle", "none")'),
      marker_end: z.string().max(16).optional().describe('End marker (e.g., "arrow", "circle", "none")'),
      style: z.record(z.unknown()).optional().describe('Style overrides JSON (stroke, dashed, etc.)'),
      waypoints: z.array(z.object({ x: z.number(), y: z.number() })).optional().describe('Optional routed waypoints'),
    },
    returns: z.object({ data: edgeShape }),
    handler: async ({ id, ...body }) => {
      const result = await client.request('POST', `/diagrams/${id}/edges`, body);
      return result.ok ? ok(result.data) : err('adding blueprint edge', result.data);
    },
  });

  registerTool(server, {
    name: 'blueprint_update_edge',
    description:
      "Update fields on a Blueprint edge. Provide only the fields to change. Pass `waypoints: null` to clear waypoints and let the renderer route the edge automatically.",
    input: {
      id: z.string().uuid().describe('Diagram ID'),
      edge_id: z.string().uuid().describe('Edge ID'),
      source_handle: z.string().max(64).nullable().optional().describe('Updated source handle'),
      target_handle: z.string().max(64).nullable().optional().describe('Updated target handle'),
      kind: z.string().max(32).optional().describe('Updated edge kind'),
      label: z.string().max(2000).nullable().optional().describe('Updated label (null to clear)'),
      marker_start: z.string().max(16).optional().describe('Updated start marker'),
      marker_end: z.string().max(16).optional().describe('Updated end marker'),
      style: z.record(z.unknown()).optional().describe('Updated style JSON'),
      waypoints: z.array(z.object({ x: z.number(), y: z.number() })).nullable().optional().describe('Updated waypoints (null to clear)'),
    },
    returns: z.object({ data: edgeShape }),
    handler: async ({ id, edge_id, ...body }) => {
      const result = await client.request('PATCH', `/diagrams/${id}/edges/${edge_id}`, body);
      return result.ok ? ok(result.data) : err('updating blueprint edge', result.data);
    },
  });

  registerTool(server, {
    name: 'blueprint_delete_edge',
    description:
      "Delete an edge from a Blueprint diagram. Destructive — requires confirm_action=true to actually proceed. Call once with confirm_action: false (or omit) to preview, then call again with true to commit.",
    input: {
      id: z.string().uuid().describe('Diagram ID'),
      edge_id: z.string().uuid().describe('Edge ID to delete'),
      confirm_action: z.boolean().describe('Must be true to actually delete. Call once with false (or omit) to preview the action, then call again with true.'),
    },
    returns: z.object({ data: z.object({ id: z.string().uuid(), deleted: z.boolean() }) }).passthrough(),
    handler: async ({ id, edge_id, confirm_action }) => {
      if (!confirm_action) {
        return {
          content: [{
            type: 'text' as const,
            text: `Are you sure you want to delete edge ${edge_id} from Blueprint diagram ${id}? Call blueprint_delete_edge again with confirm_action: true to proceed.`,
          }],
        };
      }
      const result = await client.request('DELETE', `/diagrams/${id}/edges/${edge_id}`);
      return result.ok ? ok(result.data) : err('deleting blueprint edge', result.data);
    },
  });

  // ===== LAYOUT + GENERATE (2) =====

  registerTool(server, {
    name: 'blueprint_apply_layout',
    description:
      "Run ELK auto-layout on a Blueprint diagram. `algorithm` overrides the diagram's stored default ('layered', 'mrtree', 'force', 'radial', 'stress'). `direction` is honored for layered layouts. Pinned nodes stay in place. Graphs above the api's in-process node limit are queued via a BullMQ worker job and the response surfaces `{ status: 'queued' }` instead of positions.",
    input: {
      id: z.string().uuid().describe('Diagram ID'),
      algorithm: z.string().max(32).optional().describe('ELK algorithm name override (e.g., "layered", "mrtree", "force", "radial", "stress")'),
      direction: z.enum(['UP', 'DOWN', 'LEFT', 'RIGHT']).optional().describe('Layout direction (layered only)'),
      spacing: z.number().int().positive().max(500).optional().describe('General spacing (px)'),
      node_node_spacing: z.number().int().positive().max(500).optional().describe('Node-to-node spacing (px)'),
      layer_spacing: z.number().int().positive().max(500).optional().describe('Layer-to-layer spacing (px, layered only)'),
    },
    returns: z.object({ data: z.unknown() }).passthrough(),
    handler: async ({ id, ...body }) => {
      const result = await client.request('POST', `/diagrams/${id}/layout`, body);
      return result.ok ? ok(result.data) : err('applying blueprint layout', result.data);
    },
  });

  registerTool(server, {
    name: 'blueprint_generate',
    description:
      "Build or extend an entire Blueprint diagram from a structured node/edge spec in ONE call. This is the headline agent surface: read a process doc or roster, emit a list of {ref, label, shape, parent_ref, ref_entity_type, ref_entity_id} node specs plus {source_ref, target_ref, label, kind} edge specs, and the server materializes uuids, wires up parent containers, then auto-layouts. `ref` is the agent-supplied local handle used to wire edges to nodes within this call; it is NOT persisted. Set `replace: true` to wipe the existing graph first (otherwise nodes/edges are appended). Set `auto_layout: false` to skip the post-generate ELK pass (defaults to true). Returns the final graph + layout result.",
    input: {
      diagram_id: z.string().uuid().describe('Diagram ID to populate or extend'),
      nodes: z.array(z.object({
        ref: z.string().min(1).max(64).describe('Local handle for cross-referencing in the edges array (not persisted)'),
        label: z.string().max(500).describe('Node label'),
        shape: z.string().max(32).optional().describe('Shape tag (defaults to "rounded")'),
        parent_ref: z.string().max(64).nullable().optional().describe('Local handle of the parent container node (must appear in this nodes array)'),
        ref_entity_type: z.string().max(32).nullable().optional().describe('Cross-product link type'),
        ref_entity_id: z.string().uuid().nullable().optional().describe('Cross-product entity UUID'),
      })).min(1).max(500).describe('Node specs (1-500)'),
      edges: z.array(z.object({
        source_ref: z.string().min(1).max(64).describe('Local handle of the source node'),
        target_ref: z.string().min(1).max(64).describe('Local handle of the target node'),
        label: z.string().max(500).optional().describe('Edge label'),
        kind: z.string().max(32).optional().describe('Edge kind tag (e.g., "reports_to", "depends_on")'),
      })).max(2000).optional().describe('Edge specs (up to 2000); refs must match entries in the nodes array'),
      auto_layout: z.boolean().optional().describe('Run ELK auto-layout after materializing nodes/edges (default true)'),
      replace: z.boolean().optional().describe('Wipe the existing graph first (default false — appends)'),
    },
    returns: z.object({ data: z.object({ graph: z.unknown(), layout: z.unknown().nullable() }) }).passthrough(),
    handler: async ({ diagram_id, ...body }) => {
      const result = await client.request('POST', `/diagrams/${diagram_id}/generate`, body);
      return result.ok ? ok(result.data) : err('generating blueprint diagram', result.data);
    },
  });

  // ===== CROSS-PRODUCT ACTIONS (2) =====

  registerTool(server, {
    name: 'blueprint_promote_graph_to_tasks',
    description:
      "Compile a Blueprint diagram into a Bam-tasks-creation plan. Returns the structured list of tasks to create (one per node) plus parent/child links to set up (one per edge), under the chosen edge-direction convention. The blueprint-api deliberately does NOT create the tasks itself — the caller (SPA or agent) drives the actual `create_task` / `bam_add_task_parent` calls so attribution stays on the caller. After tasks land, the caller should also patch each blueprint_node with ref_entity_type='bam.task' + ref_entity_id=<new task id> via blueprint_link_entity so the two-way sync hook fires. Edge-direction options: 'source-parent' (A->B means A parents B, default for mindmaps/decision trees), 'target-parent' (A->B means B parents A, for dependency graphs), 'none' (skip parent links).",
    input: {
      id: z.string().uuid().describe('Diagram ID'),
      project_id: z.string().uuid().describe('Bam project the new tasks land in'),
      phase_id: z.string().uuid().nullable().optional().describe('Phase id for new tasks (defaults to project default)'),
      sprint_id: z.string().uuid().nullable().optional().describe('Sprint id'),
      edge_direction: z
        .enum(['source-parent', 'target-parent', 'none'])
        .optional()
        .describe("How to map edges to parent/child task links. Defaults to 'source-parent'."),
    },
    returns: z.object({
      data: z.object({
        diagram_id: z.string().uuid(),
        project_id: z.string().uuid(),
        edge_direction: z.string(),
        tasks_to_create: z.array(z.unknown()),
        parent_links_to_create: z.array(z.unknown()),
        total_steps: z.number().int(),
      }).passthrough(),
    }),
    handler: async ({ id, ...body }) => {
      const result = await client.request('POST', `/diagrams/${id}/promote-to-tasks`, body);
      return result.ok ? ok(result.data) : err('promoting graph to tasks', result.data);
    },
  });

  registerTool(server, {
    name: 'blueprint_generate_from_bam',
    description:
      "Materialize a brand-new Blueprint diagram from a Bam project's tasks. Creates one node per task (with ref_entity_type='bam.task' + ref_entity_id back-link) and one edge per task parent link (using both the legacy tasks.parent_task_id self-FK and the task_parent_links many-to-many join table from B3 Frndo Launch). Auto-runs layered ELK so the diagram opens already laid out. Skips completed tasks unless include_completed=true. Reverse direction of blueprint_promote_graph_to_tasks; the two together give a round-trip Blueprint↔Bam workflow. After creation, any Bam task title/description change propagates into every linked node (and vice-versa) via the two-way sync hook.",
    input: {
      project_id: z.string().uuid().describe('Bam project whose tasks become the graph'),
      name: z.string().min(1).max(200).optional().describe('Diagram name; defaults to "<Project> — tasks"'),
      description: z.string().max(5000).nullable().optional().describe('Diagram description'),
      include_completed: z.boolean().optional().describe('Pull tasks whose phase is terminal too. Default false.'),
      sprint_id: z.string().uuid().nullable().optional().describe('When set, only tasks in this sprint are pulled.'),
      visibility: z
        .enum(['organization', 'project', 'private'])
        .optional()
        .describe("Defaults to 'project' so the diagram inherits the project's member ACL."),
      auto_layout: z.boolean().optional().describe('Run layered ELK after materialization (default true).'),
    },
    returns: z.object({
      data: z.object({
        diagram_id: z.string().uuid(),
        node_count: z.number().int(),
        edge_count: z.number().int(),
        skipped_completed_count: z.number().int(),
      }),
    }),
    handler: async (body) => {
      const result = await client.request('POST', '/diagrams/from-bam', body);
      return result.ok ? ok(result.data) : err('generating diagram from bam', result.data);
    },
  });

  registerTool(server, {
    name: 'blueprint_promote_node_to_task',
    description:
      "Generate a Bam-task payload from a Blueprint node and suggest back-linking the node to the new task. Returns a structured payload the caller can POST to /b3/api/projects/:id/tasks (the second hop is not yet executed server-side — wire-up is on the Wave 5 roadmap). Use this when a node represents work to be tracked in Bam (e.g. a swimlane step or a deliverable).",
    input: {
      id: z.string().uuid().describe('Diagram ID'),
      node_id: z.string().uuid().describe('Source node ID'),
      project_id: z.string().uuid().describe('Target Bam project UUID for the new task'),
      phase_id: z.string().uuid().optional().describe('Target phase UUID (uses project default if omitted)'),
      sprint_id: z.string().uuid().nullable().optional().describe('Target sprint UUID (null = backlog)'),
      title: z.string().max(500).optional().describe('Override task title (defaults to node label)'),
    },
    returns: z.object({
      data: z.object({
        task_payload: z.object({
          project_id: z.string().uuid(),
          title: z.string(),
          description: z.string(),
          phase_id: z.string().uuid().optional(),
          sprint_id: z.string().uuid().nullable().optional(),
        }).passthrough(),
        node: z.object({
          id: z.string().uuid(),
          suggested_link: z.object({ ref_entity_type: z.string() }).passthrough(),
        }).passthrough(),
      }).passthrough(),
    }),
    handler: async ({ id, node_id, ...body }) => {
      const result = await client.request('POST', `/diagrams/${id}/nodes/${node_id}/promote-to-task`, body);
      return result.ok ? ok(result.data) : err('promoting blueprint node to task', result.data);
    },
  });

  registerTool(server, {
    name: 'blueprint_link_entity',
    description:
      "Attach a cross-product reference to a Blueprint node so the renderer can show live status from the linked entity (e.g. a task's phase, a deal's stage, a beacon's verify state). `ref_entity_type` is one of the canonical platform link types (e.g. 'bam.task', 'beacon.entry', 'bearing.goal', 'bond.deal', 'bond.contact', 'helpdesk.ticket'). Pass a different (type, id) pair to retarget; use blueprint_update_node with null fields to clear.",
    input: {
      id: z.string().uuid().describe('Diagram ID'),
      node_id: z.string().uuid().describe('Node ID to link'),
      ref_entity_type: z.string().min(1).max(32).describe('Cross-product link type (e.g., "bam.task", "bond.deal")'),
      ref_entity_id: z.string().uuid().describe('Target entity UUID'),
    },
    returns: z.object({ data: nodeShape }),
    handler: async ({ id, node_id, ...body }) => {
      const result = await client.request('POST', `/diagrams/${id}/nodes/${node_id}/link-entity`, body);
      return result.ok ? ok(result.data) : err('linking blueprint node entity', result.data);
    },
  });
}
