import { registerTool } from '../lib/register-tool.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';

/**
 * Blip MCP tools. Blip is BigBlueBam's telemetry / log-ingest product: tracked
 * apps ship reports through write-only ingest keys, the entries land in an
 * append-only partitioned store, and humans + agents query, tail, watch, and
 * compile them through the SAME tools, identity, and audit trail. Canonical
 * bytes for screen captures and exports live in Bin; Blip owns the telemetry
 * plane.
 *
 * Mirrors the bin/bay/board pattern: a fetch wrapper forwarding the caller's
 * bearer token to blip-api, a `createBlipClient` factory, and per-tool
 * registerTool calls. The ingest POST and the live-tail WebSocket are
 * public-inbound / realtime and intentionally NOT MCP paths (§15). Destructive
 * tools (delete/revoke/purge) use the inline `confirm_action: boolean` two-step
 * preview convention, the same pattern as `bin_asset_archive`.
 */
function createBlipClient(blipApiUrl: string, api: ApiClient) {
  const baseUrl = blipApiUrl.replace(/\/$/, '');

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

const seg = (s: string) => encodeURIComponent(s);

// §7.1 filter predicate. Recursive AND/OR tree of { field, operator, value }
// leaves; net-new to Blip and modeled loosely so the shape is forwarded
// verbatim to blip-api (which owns validation/compilation).
const predicateShape = z
  .record(z.unknown())
  .describe(
    '§7.1 filter predicate: { op:"and"|"or", conditions:[{ field, operator, value }] }. ' +
      'field is a reserved column (level, elapsed_ms, session_id, ...) or "payload:dot.path". ' +
      'operator one of eq,neq,contains,not_contains,gt,gte,lt,lte,in,not_in,is_set,is_not_set.',
  );

const sortShape = z
  .array(z.object({ field: z.string(), dir: z.enum(['asc', 'desc']).default('asc') }))
  .describe('Sort spec, e.g. [{ field: "seq", dir: "desc" }]');

const appShape = z.record(z.unknown());

export function registerBlipTools(server: McpServer, api: ApiClient, blipApiUrl: string): void {
  const client = createBlipClient(blipApiUrl, api);

  // ===== Tracked apps =====

  registerTool(server, {
    name: 'blip_app_create',
    description:
      'Declare a Blip tracked app: the unit of control that owns collection on/off, the default rate limit, the default 14-day retention, PII transform rules, and the report types observed under it. Org-scoped.',
    input: {
      name: z.string().min(1).max(255).describe('Display name, e.g. "Castaway iOS"'),
      slug: z.string().min(1).max(255).optional().describe('Stable slug (defaults from name)'),
      description: z.string().max(2000).optional(),
      platform: z.string().max(64).optional().describe('Optional platform hint, e.g. ios, android, web'),
    },
    returns: z.object({ data: appShape }),
    handler: async (params) => {
      const result = await client.request('POST', '/apps', params);
      return result.ok ? ok(result.data) : err('creating blip app', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_app_list',
    description: 'List Blip tracked apps for the caller’s org, with per-app health/collection state.',
    input: {
      include_archived: z.boolean().optional().describe('Include archived/deleted apps (default false)'),
    },
    returns: z.object({ data: z.array(appShape) }),
    handler: async (params) => {
      const result = await client.request('GET', `/apps${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing blip apps', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_app_get',
    description:
      'Get a Blip tracked app’s detail: config (rate limit, retention default, transform), collection state, and health (recent ingest/error/dead-letter counts).',
    input: { id: z.string().uuid().describe('Tracked app ID') },
    returns: z.object({ data: appShape }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/apps/${id}`);
      return result.ok ? ok(result.data) : err('getting blip app', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_app_update',
    description: 'Edit a Blip tracked app’s mutable config: rename, description, platform hint.',
    input: {
      id: z.string().uuid().describe('Tracked app ID'),
      name: z.string().min(1).max(255).optional(),
      description: z.string().max(2000).nullable().optional(),
      platform: z.string().max(64).nullable().optional(),
    },
    returns: z.object({ data: appShape }),
    handler: async ({ id, ...body }) => {
      const result = await client.request('PATCH', `/apps/${id}`, body);
      return result.ok ? ok(result.data) : err('updating blip app', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_app_delete',
    description:
      'Delete a Blip tracked app and ALL of its data (keys, entries, watches, views, captures). Terminal and owner-gated. Two-step confirm: call with confirm_action omitted/false to preview, then again with confirm_action:true to proceed.',
    input: {
      id: z.string().uuid().describe('Tracked app ID'),
      confirm_action: z.boolean().optional().describe('Set true to actually delete'),
    },
    returns: z.object({ data: appShape.optional(), preview: z.string().optional() }),
    handler: async ({ id, confirm_action }) => {
      if (!confirm_action) {
        const a = await client.request('GET', `/apps/${id}`);
        return ok({
          preview: `Will permanently delete tracked app ${id} and ALL of its entries, keys, watches, views, and stored captures. Call again with confirm_action:true to proceed.`,
          app: a.data,
        });
      }
      const result = await client.request('DELETE', `/apps/${id}`);
      return result.ok ? ok(result.data) : err('deleting blip app', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_collection_set',
    description:
      'Start or stop collection for a Blip tracked app. When disabled, the edge rejects ingest with 409 within the key-cache TTL (~1s). Does not delete existing data.',
    input: {
      id: z.string().uuid().describe('Tracked app ID'),
      enabled: z.boolean().describe('true = collecting, false = paused'),
    },
    returns: z.object({ data: appShape }),
    handler: async ({ id, enabled }) => {
      const result = await client.request('POST', `/apps/${id}/collection`, { enabled });
      return result.ok ? ok(result.data) : err('setting blip collection', result.data);
    },
  });

  // ===== Ingest keys =====

  registerTool(server, {
    name: 'blip_key_create',
    description:
      'Mint a write-only ingest key for a tracked app. The full token (blip_<key_id>_<secret>) is returned EXACTLY ONCE in this response and never again; only an HMAC is stored. Optionally label it and set a per-key rate-limit override.',
    input: {
      id: z.string().uuid().describe('Tracked app ID'),
      label: z.string().max(255).optional().describe('Human label, e.g. "iOS prod"'),
      rate_limit_override: z
        .object({ refill_per_sec: z.number().positive(), burst: z.number().int().positive() })
        .nullable()
        .optional()
        .describe('Per-key token-bucket override; null/omit to inherit the app default'),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ id, ...body }) => {
      const result = await client.request('POST', `/apps/${id}/keys`, body);
      return result.ok ? ok(result.data) : err('creating blip key', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_key_list',
    description:
      'List a tracked app’s ingest keys (status, label, last4, fingerprint, last-used, rate-limit override). The secret is never returned.',
    input: { id: z.string().uuid().describe('Tracked app ID') },
    returns: z.object({ data: z.array(z.record(z.unknown())) }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/apps/${id}/keys`);
      return result.ok ? ok(result.data) : err('listing blip keys', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_key_suspend',
    description:
      'Suspend (or resume) an ingest key. Reversible: pass resume:true to flip a suspended key back to active. A suspended key’s token is rejected at the edge within the key-cache TTL (~1s).',
    input: {
      id: z.string().uuid().describe('Ingest key ID'),
      resume: z.boolean().optional().describe('true to resume (re-activate) instead of suspend'),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ id, resume }) => {
      const result = await client.request('POST', `/keys/${id}/suspend`, { resume: resume ?? false });
      return result.ok ? ok(result.data) : err('suspending blip key', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_key_revoke',
    description:
      'Revoke an ingest key. TERMINAL: the token never works again (suspend is the reversible option). The row is retained so historical entries keep their attribution. Two-step confirm: call with confirm_action omitted/false to preview, then again with confirm_action:true.',
    input: {
      id: z.string().uuid().describe('Ingest key ID'),
      confirm_action: z.boolean().optional().describe('Set true to actually revoke'),
    },
    returns: z.object({ data: z.record(z.unknown()).optional(), preview: z.string().optional() }),
    handler: async ({ id, confirm_action }) => {
      if (!confirm_action) {
        return ok({
          preview: `Will permanently revoke ingest key ${id}. This is terminal — the token can never be reactivated (use blip_key_suspend for a reversible pause). Call again with confirm_action:true to proceed.`,
        });
      }
      const result = await client.request('POST', `/keys/${id}/revoke`);
      return result.ok ? ok(result.data) : err('revoking blip key', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_key_update',
    description: 'Edit an ingest key’s label and/or per-key rate-limit override.',
    input: {
      id: z.string().uuid().describe('Ingest key ID'),
      label: z.string().max(255).nullable().optional(),
      rate_limit_override: z
        .object({ refill_per_sec: z.number().positive(), burst: z.number().int().positive() })
        .nullable()
        .optional()
        .describe('null clears the override (inherit app default)'),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ id, ...body }) => {
      const result = await client.request('PATCH', `/keys/${id}`, body);
      return result.ok ? ok(result.data) : err('updating blip key', result.data);
    },
  });

  // ===== Rate limit / retention / transform =====

  registerTool(server, {
    name: 'blip_ratelimit_set',
    description:
      'Set the tracked app’s DEFAULT rate limit (the per-key bucket used when a key has no override, and the per-app aggregate ceiling) plus body/batch/capture caps.',
    input: {
      id: z.string().uuid().describe('Tracked app ID'),
      refill_per_sec: z.number().positive().describe('Token-bucket refill rate'),
      burst: z.number().int().positive().describe('Token-bucket burst capacity'),
      max_body_bytes: z.number().int().positive().optional().describe('Default 262144 (256 KB)'),
      max_batch_count: z.number().int().positive().optional().describe('Default 500 entries per request'),
      max_capture_body_bytes: z.number().int().positive().optional().describe('Default 4 MB'),
      max_capture_bytes: z.number().int().positive().optional().describe('Per-image cap, default 2 MB'),
      max_captures_per_report: z.number().int().positive().optional().describe('Default 8'),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ id, ...body }) => {
      const result = await client.request('PUT', `/apps/${id}/rate-limit`, body);
      return result.ok ? ok(result.data) : err('setting blip rate limit', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_retention_set',
    description:
      'Set a retention policy for a tracked app. Omit report_type for the app-wide default; pass one to override a single (tracked_app, report_type). null on a cap removes that limit (explicit, never automatic). New apps default to max_age_days=14.',
    input: {
      id: z.string().uuid().describe('Tracked app ID'),
      report_type: z.string().nullable().optional().describe('null/omit = the app-wide default policy'),
      max_age_days: z.number().int().positive().nullable().optional().describe('null = no age limit'),
      max_rows: z.number().int().positive().nullable().optional().describe('null = no row cap'),
      max_bytes: z.number().int().positive().nullable().optional().describe('null = no byte cap'),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ id, ...body }) => {
      const result = await client.request('PUT', `/apps/${id}/retention`, body);
      return result.ok ? ok(result.data) : err('setting blip retention', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_transform_set',
    description:
      'Set the ordered PII/redaction transform rules for a tracked app (optionally narrowed to one report_type). Rules run on the edge before tail/store. Each rule: { match: "payload:user.email" | "glob:*token*" | "regex:...", action: "drop"|"mask"|"hash"|"truncate", params?: { keep_last?, max_len? } }.',
    input: {
      id: z.string().uuid().describe('Tracked app ID'),
      report_type: z.string().nullable().optional().describe('null/omit = applies to all report types'),
      enabled: z.boolean().optional().describe('Default true'),
      rules: z
        .array(
          z.object({
            match: z.string().describe('field path, glob:..., or regex:...'),
            action: z.enum(['drop', 'mask', 'hash', 'truncate']),
            params: z.record(z.unknown()).optional().describe('e.g. { keep_last: 4, max_len: 256 }'),
          }),
        )
        .describe('Ordered rule list; empty array clears redaction (the global length floor still applies)'),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ id, ...body }) => {
      const result = await client.request('PUT', `/apps/${id}/transform`, body);
      return result.ok ? ok(result.data) : err('setting blip transform', result.data);
    },
  });

  // ===== Report types & field catalog =====

  registerTool(server, {
    name: 'blip_report_types_list',
    description: 'List the report types observed under a tracked app (discovered from incoming data, never pre-declared).',
    input: { id: z.string().uuid().describe('Tracked app ID') },
    returns: z.object({ data: z.array(z.record(z.unknown())) }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/apps/${id}/types`);
      return result.ok ? ok(result.data) : err('listing blip report types', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_field_catalog_list',
    description:
      'List the observed-field catalog for a (tracked_app, report_type): each field path with inferred type, first/last seen, observation count, and is_metric / is_indexed flags. Powers column pickers and sort options.',
    input: {
      id: z.string().uuid().describe('Tracked app ID'),
      report_type: z.string().min(1).describe('Report type'),
    },
    returns: z.object({ data: z.array(z.record(z.unknown())) }),
    handler: async ({ id, report_type }) => {
      const result = await client.request('GET', `/apps/${id}/types/${seg(report_type)}/fields`);
      return result.ok ? ok(result.data) : err('listing blip field catalog', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_field_index',
    description:
      'Promote a JSONB field to an indexed field for a (tracked_app, report_type). Enqueues a worker job that builds CREATE INDEX CONCURRENTLY on ((payload->>field)) and flips is_indexed. Heavy and explicit; reserved columns are always indexed.',
    input: {
      id: z.string().uuid().describe('Tracked app ID'),
      report_type: z.string().min(1).describe('Report type'),
      field_path: z.string().min(1).describe('Field path, e.g. "payload:fn" or a bare JSONB key'),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ id, report_type, field_path }) => {
      const result = await client.request(
        'POST',
        `/apps/${id}/types/${seg(report_type)}/fields/${seg(field_path)}/index`,
      );
      return result.ok ? ok(result.data) : err('indexing blip field', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_field_set_metric',
    description:
      'Mark or unmark a numeric field as a Bench metric for a (tracked_app, report_type). Metric fields are included in the numeric Bench rollup. Pass is_metric:false to unmark.',
    input: {
      id: z.string().uuid().describe('Tracked app ID'),
      report_type: z.string().min(1).describe('Report type'),
      field_path: z.string().min(1).describe('Field path'),
      is_metric: z.boolean().optional().describe('Default true; pass false to unmark'),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ id, report_type, field_path, is_metric }) => {
      const result = await client.request(
        'POST',
        `/apps/${id}/types/${seg(report_type)}/fields/${seg(field_path)}/metric`,
        { is_metric: is_metric ?? true },
      );
      return result.ok ? ok(result.data) : err('setting blip metric', result.data);
    },
  });

  // ===== Entries: query / tail / purge / export =====

  registerTool(server, {
    name: 'blip_entry_query',
    description:
      'Query entries for a (tracked_app, report_type): a §7.1 filter predicate, column projection, sort, and a page (limit/offset). Pass format:"jsonl" for newline-delimited output. The durable store is authoritative; this is not the live tail.',
    input: {
      id: z.string().uuid().describe('Tracked app ID'),
      report_type: z.string().min(1).describe('Report type'),
      filter: predicateShape.optional(),
      columns: z.array(z.string()).optional().describe('Project to these fields'),
      sort: sortShape.optional().describe('Default [{ field: "seq", dir: "desc" }]'),
      limit: z.number().int().positive().max(1000).optional().describe('Page size (default 100, max 1000)'),
      offset: z.number().int().min(0).optional(),
      format: z.enum(['json', 'jsonl']).optional().describe('Default json'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, ...body }) => {
      const result = await client.request('POST', `/apps/${id}/entries/query`, body);
      return result.ok ? ok(result.data) : err('querying blip entries', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_entry_tail',
    description:
      'Incremental pull of entries for a (tracked_app, report_type) with seq > cursor, plus the new max seq for the next call. The polling complement to the realtime WebSocket tail; ideal for agents draining new telemetry on an interval. Omit cursor for the first call.',
    input: {
      id: z.string().uuid().describe('Tracked app ID'),
      report_type: z.string().min(1).describe('Report type'),
      cursor: z.union([z.string(), z.number()]).optional().describe('Highest seq already seen (omit for first pull)'),
      filter: predicateShape.optional(),
      columns: z.array(z.string()).optional(),
      limit: z.number().int().positive().max(1000).optional().describe('Max entries this pull (default 100)'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, ...body }) => {
      const result = await client.request('POST', `/apps/${id}/entries/tail`, body);
      return result.ok ? ok(result.data) : err('tailing blip entries', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_entry_purge',
    description:
      'Purge entries for a (tracked_app, report_type), optionally narrowed by a §7.1 filter. Deletes durable rows and reclaims their stored captures; compiled timelapse videos are independent Bin assets and are not affected. Two-step confirm: call with confirm_action omitted/false to preview, then again with confirm_action:true.',
    input: {
      id: z.string().uuid().describe('Tracked app ID'),
      report_type: z.string().min(1).describe('Report type'),
      filter: predicateShape.optional().describe('Omit to purge the entire (app, report_type) collection'),
      confirm_action: z.boolean().optional().describe('Set true to actually purge'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, report_type, filter, confirm_action }) => {
      if (!confirm_action) {
        return ok({
          preview: `Will permanently purge entries for app ${id}, report_type "${report_type}"${
            filter ? ' matching the supplied filter' : ' (the ENTIRE collection — no filter supplied)'
          }, including their stored captures. Call again with confirm_action:true to proceed.`,
        });
      }
      const result = await client.request('POST', `/apps/${id}/entries/purge`, { report_type, filter });
      return result.ok ? ok(result.data) : err('purging blip entries', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_entry_export',
    description:
      'Freeze a (tracked_app, report_type) collection (optionally filtered) into an immutable JSONL asset in Bin, returning the Bin asset ref. Use for archival, sharing, or feeding the frozen log into the Bin structured-data viewer.',
    input: {
      id: z.string().uuid().describe('Tracked app ID'),
      report_type: z.string().min(1).describe('Report type'),
      filter: predicateShape.optional(),
      columns: z.array(z.string()).optional().describe('Project the exported rows to these fields'),
      name: z.string().max(512).optional().describe('Name for the resulting Bin asset'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, ...body }) => {
      const result = await client.request('POST', `/apps/${id}/entries/export`, body);
      return result.ok ? ok(result.data) : err('exporting blip entries', result.data);
    },
  });

  // ===== Captures & timelapse =====

  registerTool(server, {
    name: 'blip_capture_url',
    description:
      'Get a short-TTL presigned GET URL for a stored screen capture (or its thumbnail). Agents and the viewer never receive base64; they resolve capture refs to URLs through this tool. Pass thumb:true for the thumbnail key.',
    input: {
      ref: z.string().min(1).describe('Capture ref / object key from an entry’s screen_captures[]'),
      thumb: z.boolean().optional().describe('true = presign the thumbnail instead of the full image'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ ref, thumb }) => {
      const result = await client.request('GET', `/captures/${seg(ref)}/url${thumb ? '?thumb=true' : ''}`);
      return result.ok ? ok(result.data) : err('getting blip capture url', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_timelapse_create',
    description:
      'Compile an ordered, filtered collection of capture-bearing entries into an MP4 (stored as a Bin asset). The intent case is a session timelapse: filter to one session_id with captures, order by seq, one frame per capture. Enqueues a worker job; poll blip_timelapse_get or react to the timelapse.ready event.',
    input: {
      id: z.string().uuid().describe('Tracked app ID'),
      report_type: z.string().optional().describe('Optional report-type scope'),
      filter: predicateShape.describe('§7.1 predicate, typically session_id eq ... and screen_captures is_set'),
      order: sortShape.optional().describe('Default [{ field: "seq", dir: "asc" }]'),
      frame_duration_sec: z.number().positive().optional().describe('Per-frame duration, default 0.5'),
      image_selection: z.enum(['first', 'all']).optional().describe('Which images to take per multi-image entry (default first)'),
      max_dimension: z.number().int().positive().optional().describe('Downscale ceiling; frames padded to a common canvas'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, ...body }) => {
      const result = await client.request('POST', `/apps/${id}/timelapse`, body);
      return result.ok ? ok(result.data) : err('creating blip timelapse', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_timelapse_get',
    description: 'Get a timelapse job’s status (queued|running|ready|failed), frame count, and the Bin video asset ref when ready.',
    input: { id: z.string().uuid().describe('Timelapse job ID') },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/timelapse/${id}`);
      return result.ok ? ok(result.data) : err('getting blip timelapse', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_timelapse_list',
    description: 'List timelapse compilation jobs for a tracked app (newest first), with status and video asset refs.',
    input: { id: z.string().uuid().describe('Tracked app ID') },
    returns: z.object({ data: z.array(z.record(z.unknown())) }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/apps/${id}/timelapse`);
      return result.ok ? ok(result.data) : err('listing blip timelapses', result.data);
    },
  });

  // ===== Watches =====

  registerTool(server, {
    name: 'blip_watch_create',
    description:
      'Create a watch on a (tracked_app, report_type) that emits a Bolt event when satisfied. kind "match" fires per-entry on a §7.1 predicate (event entry.matched); kind "window" evaluates an aggregate over a trailing window and emits window.breached / window.recovered. A per-watch cooldown caps fire frequency.',
    input: {
      id: z.string().uuid().describe('Tracked app ID'),
      name: z.string().min(1).max(255).describe('Stable handle Bolt rules filter on'),
      kind: z.enum(['match', 'window']),
      report_type: z.string().nullable().optional().describe('null/omit = all report types for the app'),
      description: z.string().max(2000).optional(),
      predicate: z
        .record(z.unknown())
        .describe(
          'match: a §7.1 filter tree. window: { window_sec, aggregate:{ op:"count"|"rate"|"avg"|"min"|"max"|"p50"|"p95"|"p99", field? }, comparator:{ operator:"gt"|"gte"|"lt"|"lte", value } }',
        ),
      cooldown_sec: z.number().int().min(0).optional().describe('Min seconds between fires (default 60; 0 = every match)'),
      enabled: z.boolean().optional().describe('Default true'),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ id, ...body }) => {
      const result = await client.request('POST', `/apps/${id}/watches`, body);
      return result.ok ? ok(result.data) : err('creating blip watch', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_watch_list',
    description: 'List watches configured for a tracked app (match and window), with enabled state and last-fired time.',
    input: { id: z.string().uuid().describe('Tracked app ID') },
    returns: z.object({ data: z.array(z.record(z.unknown())) }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/apps/${id}/watches`);
      return result.ok ? ok(result.data) : err('listing blip watches', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_watch_get',
    description: 'Get a watch’s detail: kind, predicate, cooldown, enabled state, and last-fired time.',
    input: { id: z.string().uuid().describe('Watch ID') },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/watches/${id}`);
      return result.ok ? ok(result.data) : err('getting blip watch', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_watch_update',
    description: 'Edit a watch: name, description, predicate, cooldown, and/or report-type scope.',
    input: {
      id: z.string().uuid().describe('Watch ID'),
      name: z.string().min(1).max(255).optional(),
      description: z.string().max(2000).nullable().optional(),
      report_type: z.string().nullable().optional(),
      predicate: z.record(z.unknown()).optional(),
      cooldown_sec: z.number().int().min(0).optional(),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ id, ...body }) => {
      const result = await client.request('PATCH', `/watches/${id}`, body);
      return result.ok ? ok(result.data) : err('updating blip watch', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_watch_set_enabled',
    description: 'Enable or disable a watch without deleting it.',
    input: {
      id: z.string().uuid().describe('Watch ID'),
      enabled: z.boolean().describe('true = enabled, false = disabled'),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ id, enabled }) => {
      const result = await client.request('POST', `/watches/${id}/enabled`, { enabled });
      return result.ok ? ok(result.data) : err('setting blip watch enabled', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_watch_delete',
    description:
      'Delete a watch. Two-step confirm: call with confirm_action omitted/false to preview, then again with confirm_action:true to proceed. (Use blip_watch_set_enabled to pause without deleting.)',
    input: {
      id: z.string().uuid().describe('Watch ID'),
      confirm_action: z.boolean().optional().describe('Set true to actually delete'),
    },
    returns: z.object({ data: z.record(z.unknown()).optional(), preview: z.string().optional() }),
    handler: async ({ id, confirm_action }) => {
      if (!confirm_action) {
        const w = await client.request('GET', `/watches/${id}`);
        return ok({
          preview: `Will delete watch ${id}. Call again with confirm_action:true to proceed (or use blip_watch_set_enabled to pause it instead).`,
          watch: w.data,
        });
      }
      const result = await client.request('DELETE', `/watches/${id}`);
      return result.ok ? ok(result.data) : err('deleting blip watch', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_watch_test',
    description:
      'Dry-run a watch predicate against recent entries for a (tracked_app, report_type) and return what would have matched (or the aggregate value vs threshold), so a watch can be validated before it is enabled. Does not create a watch or emit events.',
    input: {
      id: z.string().uuid().describe('Tracked app ID'),
      kind: z.enum(['match', 'window']).optional().describe('Default match'),
      report_type: z.string().nullable().optional(),
      predicate: z.record(z.unknown()).describe('Same shape as blip_watch_create.predicate'),
      limit: z.number().int().positive().max(1000).optional().describe('Max sample entries to evaluate'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, ...body }) => {
      const result = await client.request('POST', `/apps/${id}/watches/test`, body);
      return result.ok ? ok(result.data) : err('testing blip watch', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_watch_history',
    description: 'List recent firings of a watch (entry.matched / window.breached / window.recovered) with their context, newest first.',
    input: {
      id: z.string().uuid().describe('Watch ID'),
      limit: z.number().int().positive().max(500).optional().describe('Max firings to return'),
    },
    returns: z.object({ data: z.array(z.record(z.unknown())) }),
    handler: async ({ id, limit }) => {
      const result = await client.request('GET', `/watches/${id}/history${buildQs({ limit })}`);
      return result.ok ? ok(result.data) : err('getting blip watch history', result.data);
    },
  });

  // ===== Saved views =====

  registerTool(server, {
    name: 'blip_view_create',
    description:
      'Create a saved view over a (tracked_app, report_type): filter + columns + sort + live-tail + page size. scope "private" is visible only to the owner; "org" to anyone who can_access the tracked app. Report types are fully usable with zero views (a default view is auto-provided).',
    input: {
      tracked_app_id: z.string().uuid().describe('Tracked app ID'),
      report_type: z.string().min(1).describe('Report type'),
      name: z.string().min(1).max(255),
      scope: z.enum(['private', 'org']).optional().describe('Default private'),
      spec: z
        .record(z.unknown())
        .describe('{ filter, columns:[{field,label?,width?}], sort:[{field,dir}], liveTail:boolean, pageSize:number }'),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async (params) => {
      const result = await client.request('POST', '/views', params);
      return result.ok ? ok(result.data) : err('creating blip view', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_view_list',
    description: 'List saved views for a (tracked_app, report_type) visible to the caller (own private views plus org-shared views).',
    input: {
      id: z.string().uuid().describe('Tracked app ID'),
      report_type: z.string().min(1).describe('Report type'),
    },
    returns: z.object({ data: z.array(z.record(z.unknown())) }),
    handler: async ({ id, report_type }) => {
      const result = await client.request('GET', `/apps/${id}/types/${seg(report_type)}/views`);
      return result.ok ? ok(result.data) : err('listing blip views', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_view_update',
    description:
      'Edit a saved view’s name, scope, or spec. Editing an org-shared view requires being its owner or an admin.',
    input: {
      id: z.string().uuid().describe('View ID'),
      name: z.string().min(1).max(255).optional(),
      scope: z.enum(['private', 'org']).optional(),
      spec: z.record(z.unknown()).optional(),
    },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ id, ...body }) => {
      const result = await client.request('PATCH', `/views/${id}`, body);
      return result.ok ? ok(result.data) : err('updating blip view', result.data);
    },
  });

  registerTool(server, {
    name: 'blip_view_delete',
    description: 'Delete a saved view (owner or admin). Views are personal/operational config, not telemetry data; no entry data is affected.',
    input: { id: z.string().uuid().describe('View ID') },
    returns: z.object({ data: z.record(z.unknown()) }),
    handler: async ({ id }) => {
      const result = await client.request('DELETE', `/views/${id}`);
      return result.ok ? ok(result.data) : err('deleting blip view', result.data);
    },
  });
}
