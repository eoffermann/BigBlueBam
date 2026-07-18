import { registerTool } from '../lib/register-tool.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';

/** HTTP client for the basis-api service (mirrors createBenchClient). */
function createBasisClient(basisApiUrl: string, api: ApiClient) {
  const baseUrl = basisApiUrl.replace(/\/$/, '');
  async function request(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = {};
    const token = (api as unknown as { token?: string }).token;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await fetch(`${baseUrl}${path}`, init);
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

const measureSchema = z.object({ field: z.string(), agg: z.enum(['sum', 'count', 'avg', 'min', 'max']) });
const definitionSchema = z.object({
  source_product: z.string(),
  source_entity: z.string(),
  measure: measureSchema,
  filters: z.array(z.object({ field: z.string(), op: z.string(), value: z.unknown() })).optional(),
  default_dimensions: z.array(z.string()).optional(),
  time_column: z.string(),
});
const periodSchema = z.object({ from: z.string(), to: z.string() });

export function registerBasisTools(server: McpServer, api: ApiClient, basisApiUrl: string): void {
  const client = createBasisClient(basisApiUrl, api);

  registerTool(server, {
    name: 'basis_list_metrics',
    description: 'List governed Basis metrics for the current organization, optionally filtered by certification state.',
    input: { certification: z.enum(['draft', 'certified', 'deprecated']).optional() },
    returns: z.object({ data: z.array(z.record(z.unknown())) }).passthrough(),
    handler: async ({ certification }) => {
      const q = certification ? `?filter[certification]=${certification}` : '';
      const r = await client.request('GET', `/metrics${q}`);
      return r.ok ? ok(r.data) : err('listing metrics', r.data);
    },
  });

  registerTool(server, {
    name: 'basis_search_metrics',
    description: 'Search Basis metrics by name/slug substring (case-insensitive) within the org.',
    input: { query: z.string().describe('Substring to match against metric name or slug') },
    returns: z.object({ data: z.array(z.record(z.unknown())) }).passthrough(),
    handler: async ({ query }) => {
      const r = await client.request('GET', '/metrics');
      if (!r.ok) return err('searching metrics', r.data);
      const rows = ((r.data as { data?: { name?: string; slug?: string }[] }).data ?? []).filter(
        (m) =>
          m.name?.toLowerCase().includes(query.toLowerCase()) ||
          m.slug?.toLowerCase().includes(query.toLowerCase()),
      );
      return ok({ data: rows });
    },
  });

  registerTool(server, {
    name: 'basis_get_metric',
    description: 'Get a Basis metric with its current version definition.',
    input: { id: z.string().uuid() },
    returns: z.record(z.unknown()),
    handler: async ({ id }) => {
      const r = await client.request('GET', `/metrics/${id}`);
      return r.ok ? ok(r.data) : err('getting metric', r.data);
    },
  });

  registerTool(server, {
    name: 'basis_metric_value',
    description: 'Get a certified metric value over a period. Returns UPSTREAM_UNAVAILABLE if the Bench query service is down.',
    input: { id: z.string().uuid(), from: z.string(), to: z.string() },
    returns: z.object({ value: z.number().nullable(), unit: z.string() }).passthrough(),
    handler: async ({ id, from, to }) => {
      const r = await client.request('GET', `/metrics/${id}/value?from=${from}&to=${to}`);
      return r.ok ? ok(r.data) : err('getting metric value', r.data);
    },
  });

  registerTool(server, {
    name: 'basis_metric_lineage',
    description: 'Get a metric binding contract: its query definition and certified presentation envelope (unit, direction, target).',
    input: { id: z.string().uuid() },
    returns: z.record(z.unknown()),
    handler: async ({ id }) => {
      const r = await client.request('GET', `/metrics/${id}/resolve`);
      return r.ok ? ok(r.data) : err('getting metric lineage', r.data);
    },
  });

  registerTool(server, {
    name: 'basis_explain_change',
    description:
      'Explain why a metric changed between two periods: a deterministic dimensional decomposition plus a per-viewer, access-scoped "possibly related activity" aid. REQUIRES asker_user_id; when omitted, Class-B (entity) breakdowns collapse to a single hidden aggregate (fail-closed).',
    input: {
      id: z.string().uuid(),
      period_a: periodSchema,
      period_b: periodSchema,
      dimension: z.string().optional(),
      asker_user_id: z.string().uuid().optional().describe('The human on whose behalf the agent is asking; gates per-entity visibility'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, ...body }) => {
      const r = await client.request('POST', `/metrics/${id}/explain`, body);
      return r.ok ? ok(r.data) : err('explaining metric change', r.data);
    },
  });

  registerTool(server, {
    name: 'basis_rank_drivers',
    description:
      'Rank the deterministic drivers of a metric delta (dimension-value contributions). Same fail-closed asker rule as basis_explain_change.',
    input: {
      id: z.string().uuid(),
      period_a: periodSchema,
      period_b: periodSchema,
      dimension: z.string().optional(),
      asker_user_id: z.string().uuid().optional(),
    },
    returns: z.object({ drivers: z.array(z.record(z.unknown())) }).passthrough(),
    handler: async ({ id, ...body }) => {
      const r = await client.request('POST', `/metrics/${id}/explain`, body);
      if (!r.ok) return err('ranking drivers', r.data);
      const drivers = (r.data as { data?: { drivers?: unknown } }).data?.drivers ?? [];
      return ok({ drivers });
    },
  });

  registerTool(server, {
    name: 'basis_define_metric',
    description: 'Define a NEW draft Basis metric (draft only; certification is a separate HITL-gated step).',
    input: {
      slug: z.string(),
      name: z.string(),
      unit: z.enum(['currency', 'count', 'percent', 'ratio', 'duration_ms']),
      favorable_direction: z.enum(['up', 'down', 'neutral']).optional(),
      description: z.string().optional(),
      definition: definitionSchema,
    },
    returns: z.record(z.unknown()),
    handler: async (body) => {
      const r = await client.request('POST', '/metrics', body);
      return r.ok ? ok(r.data) : err('defining metric', r.data);
    },
  });

  // Two-step confirm helper (mirrors blip_app_delete): the first call (no
  // confirm_action) returns a preview of the current metric + certification so a
  // reviewer sees exactly what will flip; only confirm_action:true mutates. This
  // is the platform's inline two-step convention for truth-flip/destructive MCP
  // actions (security review #50/#58).
  async function previewMetric(id: string, willDo: string) {
    const a = await client.request('GET', `/metrics/${id}`);
    return ok({
      preview: `${willDo} Call again with confirm_action:true to proceed.`,
      metric: a.data,
    });
  }

  registerTool(server, {
    name: 'basis_add_metric_version',
    description:
      'Add a new immutable definition version to a metric. Versioning a certified metric changes the org-wide source of truth, so this is a two-step confirm: call with confirm_action omitted/false to preview the current metric, then again with confirm_action:true to proceed.',
    input: {
      id: z.string().uuid(),
      definition: definitionSchema,
      change_note: z.string().optional(),
      confirm_action: z.boolean().optional().describe('Set true to actually add the version'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, confirm_action, ...body }) => {
      if (!confirm_action) {
        return previewMetric(id, `Will add a new immutable definition version to metric ${id}, re-baselining its history.`);
      }
      const r = await client.request('POST', `/metrics/${id}/versions`, body);
      return r.ok ? ok(r.data) : err('adding metric version', r.data);
    },
  });

  registerTool(server, {
    name: 'basis_certify_metric',
    description:
      'Certify a metric so it becomes the org-wide source of truth (truth-flip). Two-step confirm: call with confirm_action omitted/false to preview, then again with confirm_action:true to proceed.',
    input: {
      id: z.string().uuid(),
      confirm_action: z.boolean().optional().describe('Set true to actually certify'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, confirm_action }) => {
      if (!confirm_action) {
        return previewMetric(id, `Will certify metric ${id}, making it the org-wide source of truth.`);
      }
      const r = await client.request('POST', `/metrics/${id}/certify`);
      return r.ok ? ok(r.data) : err('certifying metric', r.data);
    },
  });

  registerTool(server, {
    name: 'basis_decertify_metric',
    description:
      'Return a certified metric to draft (truth-flip). Two-step confirm: call with confirm_action omitted/false to preview, then again with confirm_action:true to proceed.',
    input: {
      id: z.string().uuid(),
      confirm_action: z.boolean().optional().describe('Set true to actually decertify'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, confirm_action }) => {
      if (!confirm_action) {
        return previewMetric(id, `Will decertify metric ${id}, returning the org-wide source of truth to draft.`);
      }
      const r = await client.request('POST', `/metrics/${id}/decertify`);
      return r.ok ? ok(r.data) : err('decertifying metric', r.data);
    },
  });

  registerTool(server, {
    name: 'basis_deprecate_metric',
    description:
      'Deprecate (soft-retire) a metric (destructive). Two-step confirm: call with confirm_action omitted/false to preview, then again with confirm_action:true to proceed.',
    input: {
      id: z.string().uuid(),
      confirm_action: z.boolean().optional().describe('Set true to actually deprecate'),
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, confirm_action }) => {
      if (!confirm_action) {
        return previewMetric(id, `Will deprecate (soft-retire) metric ${id}.`);
      }
      const r = await client.request('DELETE', `/metrics/${id}`);
      return r.ok ? ok(r.data) : err('deprecating metric', r.data);
    },
  });

  // --- Read: full version history (agent parity with the detail page) --------
  registerTool(server, {
    name: 'basis_list_versions',
    description: 'List a metric\'s immutable definition version history (newest first), as shown on the metric detail page.',
    input: { id: z.string().uuid() },
    returns: z.record(z.unknown()),
    handler: async ({ id }) => {
      const r = await client.request('GET', `/metrics/${id}/versions`);
      return r.ok ? ok(r.data) : err('listing metric versions', r.data);
    },
  });

  // --- Metadata update (PATCH /metrics/:id) - not a definition/version change,
  // so no confirm; the definition still only changes via basis_add_metric_version.
  const targetInput = z
    .object({ value: z.number(), comparison: z.enum(['gte', 'lte', 'gt', 'lt']) })
    .nullable();
  registerTool(server, {
    name: 'basis_update_metric',
    description:
      'Update a metric\'s metadata (name, description, favorable_direction, owner, related_apps, target). Does NOT change the definition - use basis_add_metric_version for that.',
    input: {
      id: z.string().uuid(),
      name: z.string().min(1).max(160).optional(),
      description: z.string().max(4000).optional(),
      favorable_direction: z.enum(['up', 'down', 'neutral']).optional(),
      owner_id: z.string().uuid().nullable().optional(),
      related_apps: z.array(z.string()).max(30).optional(),
      target: targetInput.optional(),
    },
    returns: z.record(z.unknown()),
    handler: async ({ id, ...patch }) => {
      const r = await client.request('PATCH', `/metrics/${id}`, patch);
      return r.ok ? ok(r.data) : err('updating metric', r.data);
    },
  });

  // --- Per-org Basis settings (GET/PUT /settings) ----------------------------
  registerTool(server, {
    name: 'basis_get_settings',
    description: 'Get this org\'s Basis settings: default decomposition dimension, explanation cache TTL, and snapshot retention window.',
    input: {},
    returns: z.record(z.unknown()),
    handler: async () => {
      const r = await client.request('GET', '/settings');
      return r.ok ? ok(r.data) : err('getting basis settings', r.data);
    },
  });

  registerTool(server, {
    name: 'basis_update_settings',
    description: 'Update this org\'s Basis settings (default dimension, explanation cache TTL seconds, snapshot retention days; null retention = unbounded).',
    input: {
      snapshot_max_age_days: z.number().int().min(1).max(3650).nullable().optional(),
      explanation_cache_ttl_seconds: z.number().int().min(60).max(2_592_000).optional(),
      default_dimension: z.string().min(1).max(80).nullable().optional(),
    },
    returns: z.record(z.unknown()),
    handler: async (patch) => {
      const r = await client.request('PUT', '/settings', patch);
      return r.ok ? ok(r.data) : err('updating basis settings', r.data);
    },
  });
}
