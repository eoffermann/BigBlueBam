import { registerTool } from '../lib/register-tool.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';

/**
 * Bin MCP tools. Bin is BigBlueBam's storage backbone + DAM + structured-data
 * editor. The canonical artifact for any asset is an immutable version (the
 * native-format bytes); structured edits mint a new version rather than mutating
 * in place, so an agent edits a CSV/JSON/YAML asset as a first-class user with
 * the same permissions and audit trail as a human.
 *
 * Follows the board/blueprint pattern: a small fetch wrapper that forwards the
 * caller's bearer token, a `createBinClient` factory, and per-tool registerTool
 * calls. Raw byte upload/download is multipart/binary and is intentionally not
 * an MCP path (use the REST proxied upload / presigned routes for bytes).
 */
function createBinClient(binApiUrl: string, api: ApiClient) {
  const baseUrl = binApiUrl.replace(/\/$/, '');

  async function request(method: string, path: string, body?: unknown) {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {};
    const token = (api as unknown as { token?: string }).token;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
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

const assetShape = z
  .object({
    id: z.string().uuid(),
    org_id: z.string().uuid().optional(),
    project_id: z.string().uuid().nullable().optional(),
    folder_id: z.string().uuid().nullable().optional(),
    name: z.string(),
    content_type: z.string().nullable().optional(),
    current_version_id: z.string().uuid().nullable().optional(),
    size: z.number().optional(),
    scan_status: z.string().optional(),
    visibility: z.string().optional(),
    created_at: z.string().optional(),
    archived_at: z.string().nullable().optional(),
  })
  .passthrough();

export function registerBinTools(server: McpServer, api: ApiClient, binApiUrl: string): void {
  const client = createBinClient(binApiUrl, api);

  // ===== DAM: assets / folders / versions =====

  registerTool(server, {
    name: 'bin_asset_list',
    description:
      'List Bin assets (the DAM library) visible to the caller, optionally scoped to a folder (pass folder_id="root" for unfiled) or project, and optionally including archived. Returns metadata only; use bin_data_read for structured-data contents.',
    input: {
      folder_id: z.string().optional().describe('Folder UUID, or "root" for unfiled assets'),
      project_id: z.string().uuid().optional().describe('Filter by project'),
      include_archived: z.boolean().optional().describe('Include archived assets (default false)'),
    },
    returns: z.object({ data: z.array(assetShape) }),
    handler: async (params) => {
      const result = await client.request('GET', `/assets${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing bin assets', result.data);
    },
  });

  registerTool(server, {
    name: 'bin_asset_get',
    description:
      "Get a Bin asset's metadata: name, content type, current version, size, scan status (serving is gated until clean/skipped), visibility, and folder/project placement.",
    input: { id: z.string().uuid().describe('Asset ID') },
    returns: z.object({ data: assetShape }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/assets/${id}`);
      return result.ok ? ok(result.data) : err('getting bin asset', result.data);
    },
  });

  registerTool(server, {
    name: 'bin_asset_create',
    description:
      'Create a Bin asset (metadata only; the first version bytes are uploaded separately via the REST upload route). Use this to register a new file before uploading content, or to create a placeholder an agent will fill via bin_data_append_rows on a structured asset.',
    input: {
      name: z.string().min(1).max(512).describe('Asset / file name (extension informs the structured-data format)'),
      content_type: z.string().min(1).max(255).describe('MIME type, e.g. text/csv, application/json'),
      folder_id: z.string().uuid().nullable().optional().describe('Containing folder'),
      project_id: z.string().uuid().nullable().optional().describe('Owning project'),
      visibility: z.enum(['organization', 'project', 'private']).optional(),
    },
    returns: z.object({ data: assetShape }),
    handler: async (params) => {
      const result = await client.request('POST', '/assets', params);
      return result.ok ? ok(result.data) : err('creating bin asset', result.data);
    },
  });

  registerTool(server, {
    name: 'bin_asset_archive',
    description:
      'Archive (soft-delete) a Bin asset. Two-step confirm: call with confirm_action omitted/false to preview, then again with confirm_action:true to proceed. The asset is hidden from default listings but versions are retained.',
    input: {
      id: z.string().uuid().describe('Asset ID'),
      confirm_action: z.boolean().optional().describe('Set true to actually archive'),
    },
    returns: z.object({ data: assetShape.optional(), preview: z.string().optional() }),
    handler: async ({ id, confirm_action }) => {
      if (!confirm_action) {
        const a = await client.request('GET', `/assets/${id}`);
        return ok({
          preview: `Will archive asset ${id}. Call again with confirm_action:true to proceed.`,
          asset: a.data,
        });
      }
      const result = await client.request('POST', `/assets/${id}/archive`);
      return result.ok ? ok(result.data) : err('archiving bin asset', result.data);
    },
  });

  registerTool(server, {
    name: 'bin_version_list',
    description:
      'List the immutable versions of a Bin asset, newest first. Each upload or structured-editor commit mints a monotonic version_number; bytes are never edited in place.',
    input: { id: z.string().uuid().describe('Asset ID') },
    returns: z.object({ data: z.array(z.record(z.unknown())) }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/assets/${id}/versions`);
      return result.ok ? ok(result.data) : err('listing bin versions', result.data);
    },
  });

  registerTool(server, {
    name: 'bin_folder_list',
    description: 'List Bin folders for the caller’s org, optionally scoped to a project.',
    input: { project_id: z.string().uuid().optional() },
    returns: z.object({ data: z.array(z.record(z.unknown())) }),
    handler: async (params) => {
      const result = await client.request('GET', `/folders${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing bin folders', result.data);
    },
  });

  registerTool(server, {
    name: 'bin_folder_create',
    description: 'Create a Bin folder, optionally nested under a parent and/or scoped to a project.',
    input: {
      name: z.string().min(1).max(255),
      parent_id: z.string().uuid().nullable().optional(),
      project_id: z.string().uuid().nullable().optional(),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async (params) => {
      const result = await client.request('POST', '/folders', params);
      return result.ok ? ok(result.data) : err('creating bin folder', result.data);
    },
  });

  // ===== Structured-data editor =====

  registerTool(server, {
    name: 'bin_data_read',
    description:
      'Read a structured-data asset (CSV/TSV/JSON/JSONL/YAML) as records or a tree. Record-shaped assets return columns + rows with optional equality filtering (filter map), column projection, and offset/limit paging, plus an inferred field schema. Tree-shaped assets return the reconstructed value. Gated on scan status (clean/skipped only).',
    input: {
      asset_id: z.string().uuid().describe('Asset ID'),
      filter: z.record(z.string()).optional().describe('Equality filter: { column: value } (record shape)'),
      columns: z.array(z.string()).optional().describe('Project to these columns (record shape)'),
      limit: z.number().int().positive().optional().describe('Max rows (default 1000)'),
      offset: z.number().int().min(0).optional().describe('Row offset for paging'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ asset_id, filter, columns, limit, offset }) => {
      const qs = new URLSearchParams();
      if (filter) for (const [k, v] of Object.entries(filter)) qs.set(`filter[${k}]`, v);
      if (columns?.length) qs.set('columns', columns.join(','));
      if (limit !== undefined) qs.set('limit', String(limit));
      if (offset !== undefined) qs.set('offset', String(offset));
      const q = qs.toString();
      const result = await client.request('GET', `/data/${asset_id}${q ? `?${q}` : ''}`);
      return result.ok ? ok(result.data) : err('reading bin data', result.data);
    },
  });

  registerTool(server, {
    name: 'bin_data_open_session',
    description:
      'Open or resume the editing session for a structured-data asset. Returns the detected shape, the schema (pinned or inferred), the dialect, the base version, and the /bin/ws collaboration room. Use before a series of edits; the live human editor shares the same session.',
    input: { asset_id: z.string().uuid().describe('Asset ID') },
    returns: z.record(z.unknown()),
    handler: async ({ asset_id }) => {
      const result = await client.request('POST', `/data/${asset_id}/session`);
      return result.ok ? ok(result.data) : err('opening bin data session', result.data);
    },
  });

  registerTool(server, {
    name: 'bin_data_append_rows',
    description:
      'Append rows to a record-shaped structured-data asset. Commits a new immutable version (the original dialect is preserved). Each row is an object keyed by column name.',
    input: {
      asset_id: z.string().uuid().describe('Asset ID'),
      rows: z.array(z.record(z.unknown())).min(1).describe('Rows to append, e.g. [{ id: "4", name: "dave" }]'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ asset_id, rows }) => {
      const result = await client.request('POST', `/data/${asset_id}/rows`, { rows });
      return result.ok ? ok(result.data) : err('appending bin rows', result.data);
    },
  });

  registerTool(server, {
    name: 'bin_data_patch',
    description:
      'Apply cell patches to a record-shaped structured-data asset by 0-based row index. Commits a new immutable version. Each patch is { index, set: { column: newValue } }.',
    input: {
      asset_id: z.string().uuid().describe('Asset ID'),
      patches: z
        .array(z.object({ index: z.number().int().min(0), set: z.record(z.unknown()) }))
        .min(1)
        .describe('e.g. [{ index: 0, set: { score: "100" } }]'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ asset_id, patches }) => {
      const result = await client.request('PATCH', `/data/${asset_id}/rows`, { patches });
      return result.ok ? ok(result.data) : err('patching bin rows', result.data);
    },
  });

  registerTool(server, {
    name: 'bin_data_patch_tree',
    description:
      'Edit a tree-shaped structured-data asset (JSON/YAML) by setting values at paths. Each patch is { path, value } where path is an array like ["passengers", 2, "vip"] or ["charter", "operator"]. Strings are coerced to the existing leaf\'s type (number/boolean). Commits a new immutable version.',
    input: {
      asset_id: z.string().uuid().describe('Asset ID'),
      patches: z
        .array(z.object({ path: z.array(z.union([z.string(), z.number()])).min(1), value: z.unknown() }))
        .min(1)
        .describe('e.g. [{ path: ["charter","tour_length_hours"], value: 4 }]'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ asset_id, patches }) => {
      const result = await client.request('PATCH', `/data/${asset_id}/tree`, { patches });
      return result.ok ? ok(result.data) : err('patching bin tree', result.data);
    },
  });

  registerTool(server, {
    name: 'bin_data_array_op',
    description:
      'Add or delete a row in any structured-data grid. path=[] targets a record asset\'s top-level rows; a path like ["passengers"] targets a tree embedded grid (array-of-dicts). op is "append" (add a row at the end; value optional), "insert" (at index), or "delete" (remove index). Commits a new immutable version.',
    input: {
      asset_id: z.string().uuid().describe('Asset ID'),
      op: z.enum(['append', 'insert', 'delete']),
      path: z.array(z.union([z.string(), z.number()])).optional().describe('Array path; omit/[] for a record asset'),
      value: z.record(z.unknown()).optional().describe('Row object for append/insert'),
      index: z.number().int().min(0).optional().describe('Target index for insert/delete'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ asset_id, ...body }) => {
      const result = await client.request('POST', `/data/${asset_id}/array`, body);
      return result.ok ? ok(result.data) : err('bin array row op', result.data);
    },
  });

  registerTool(server, {
    name: 'bin_data_comment_list',
    description: 'List review comments on a structured-data asset (open by default; pass include_resolved).',
    input: {
      asset_id: z.string().uuid().describe('Asset ID'),
      include_resolved: z.boolean().optional(),
    },
    returns: z.object({ data: z.array(z.record(z.unknown())) }),
    handler: async ({ asset_id, include_resolved }) => {
      const result = await client.request(
        'GET',
        `/data/${asset_id}/comments${include_resolved ? '?include_resolved=true' : ''}`,
      );
      return result.ok ? ok(result.data) : err('listing bin comments', result.data);
    },
  });

  registerTool(server, {
    name: 'bin_data_comment_create',
    description:
      'Add a review comment anchored to a cell/path of a structured-data asset. Record anchor: { rid, colId? }; tree anchor: { pointer }. Comments are authored by humans or agents identically.',
    input: {
      asset_id: z.string().uuid().describe('Asset ID'),
      shape: z.enum(['record', 'tree']),
      anchor: z.record(z.unknown()).describe('record: { rid, colId? } ; tree: { pointer }'),
      body: z.string().min(1).max(10000).describe('Markdown comment body'),
      thread_parent_id: z.string().uuid().nullable().optional().describe('Reply target'),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ asset_id, ...body }) => {
      const result = await client.request('POST', `/data/${asset_id}/comments`, body);
      return result.ok ? ok(result.data) : err('creating bin comment', result.data);
    },
  });

  registerTool(server, {
    name: 'bin_data_comment_resolve',
    description: 'Mark a structured-data review comment resolved (or reopen it with resolved:false).',
    input: {
      asset_id: z.string().uuid().describe('Asset ID'),
      comment_id: z.string().uuid().describe('Comment ID'),
      resolved: z.boolean().optional().describe('Default true'),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ asset_id, comment_id, resolved }) => {
      const result = await client.request('POST', `/data/${asset_id}/comments/${comment_id}/resolve`, {
        resolved: resolved ?? true,
      });
      return result.ok ? ok(result.data) : err('resolving bin comment', result.data);
    },
  });
}
