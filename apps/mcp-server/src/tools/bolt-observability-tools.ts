// §12 Wave 5 bolt observability
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { registerTool } from '../lib/register-tool.js';

/**
 * Bolt observability MCP tools (AGENTIC_TODO §12, Wave 5).
 *
 * Tools:
 *   - bolt_event_trace    GET /v1/events/:event_id/trace
 *   - bolt_recent_events  GET /v1/events/recent?source=&event=&since=&limit=
 *
 * bolt_event_trace returns every automation that evaluated the ingest event
 * plus per-rule condition outcomes and action outcomes, so a caller can
 * explain "why did (or didn't) rule X fire for event Y". bolt_recent_events
 * is the live-ish inspection counterpart — the last N ingest events the
 * caller's org saw, with source/event filters.
 *
 * Both tools share the same lightweight auth-forwarding fetch wrapper as
 * bolt-tools.ts (org scoping is enforced server-side by the bolt-api
 * auth plugin).
 */

function createBoltClient(boltApiUrl: string, api: ApiClient) {
  const baseUrl = boltApiUrl.replace(/\/$/, '');

  async function request(method: string, path: string, body?: unknown) {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {};
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
    if (value !== undefined && value !== null && value !== '') sp.set(key, String(value));
  }
  const qs = sp.toString();
  return qs ? `?${qs}` : '';
}

const traceConditionShape = z
  .object({
    condition_id: z.string().nullable(),
    operator: z.string(),
    field: z.string(),
    result: z.boolean(),
    actual: z.unknown(),
    expected: z.unknown(),
  })
  .passthrough();

const traceActionShape = z
  .object({
    mcp_tool: z.string(),
    outcome: z.string(),
    duration_ms: z.number().nullable(),
    error: z.string().optional(),
  })
  .passthrough();

const traceRuleShape = z
  .object({
    rule_id: z.string().uuid(),
    rule_name: z.string(),
    matched: z.boolean(),
    conditions: z.array(traceConditionShape),
    actions: z.array(traceActionShape),
  })
  .passthrough();

const traceEntryShape = z
  .object({
    execution_id: z.string().uuid(),
    automation_id: z.string().uuid(),
    automation_name: z.string(),
    status: z.string(),
    started_at: z.string(),
    completed_at: z.string().nullable(),
    event_id: z.string().nullable(),
    event_source: z.string().nullable(),
    event_type: z.string().nullable(),
    rules: z.array(traceRuleShape),
  })
  .passthrough();

const recentEventShape = z
  .object({
    event_id: z.string().uuid().nullable(),
    source: z.string().nullable(),
    event_type: z.string().nullable(),
    started_at: z.string(),
    matched_automations: z.number(),
    first_execution_id: z.string().uuid(),
  })
  .passthrough();

export function registerBoltObservabilityTools(
  server: McpServer,
  api: ApiClient,
  boltApiUrl: string,
): void {
  const client = createBoltClient(boltApiUrl, api);

  registerTool(server, {
    name: 'bolt_event_trace',
    description:
      "Return the full evaluation trail for a single Bolt ingest event: every automation that evaluated the event, whether its conditions matched, and the outcome of each action step. Values in actual/expected are truncated to 1KB per field. Empty executions[] means the event hit zero rules. Org-scoped: only executions in the caller's active org are returned.",
    input: {
      event_id: z
        .string()
        .uuid()
        .describe(
          'Bolt ingest event id (uuid). Returned by POST /v1/events/ingest and present on every execution row.',
        ),
    },
    returns: z.object({
      data: z.object({
        event_id: z.string().uuid(),
        executions: z.array(traceEntryShape),
      }),
    }),
    handler: async ({ event_id }) => {
      const result = await client.request(
        'GET',
        `/events/${event_id}/trace`,
      );
      return result.ok ? ok(result.data) : err('fetching event trace', result.data);
    },
  });

  registerTool(server, {
    name: 'bolt_recent_events',
    description:
      "List recent Bolt ingest events in the caller's org that matched at least one automation. Each row is aggregated by event_id with the count of matched automations and the earliest started_at. Filters are optional; limit is capped server-side at 500 (default 50). Useful for a live-ish ops view of what is firing.",
    input: {
      source: z
        .string()
        .min(1)
        .max(60)
        .optional()
        .describe('Filter by event source (e.g. bond, bam, banter)'),
      event: z
        .string()
        .min(1)
        .max(60)
        .optional()
        .describe('Filter by bare event name (e.g. deal.rotting)'),
      since: z
        .string()
        .datetime()
        .optional()
        .describe('Only events started_at >= this ISO 8601 timestamp'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('Max rows to return (default 50, hard cap 500)'),
    },
    returns: z.object({ data: z.array(recentEventShape) }),
    handler: async (params) => {
      const result = await client.request(
        'GET',
        `/events/recent${buildQs(params as Record<string, unknown>)}`,
      );
      return result.ok ? ok(result.data) : err('listing recent events', result.data);
    },
  });
}
