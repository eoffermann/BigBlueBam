import { registerTool } from '../lib/register-tool.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { isUuid } from '../middleware/resolve-helpers.js';

/**
 * Helper to make requests to the bolt-api service.
 * Same pattern as brief-tools.ts — a lightweight fetch wrapper that targets
 * the bolt-api base URL and forwards the user's auth token.
 */
function createBoltClient(boltApiUrl: string, api: ApiClient) {
  const baseUrl = boltApiUrl.replace(/\/$/, '');

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

const automationShape = z.object({
  id: z.string().uuid(),
  name: z.string(),
  enabled: z.boolean().optional(),
  trigger_source: z.string().optional(),
  trigger_event: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

const executionShape = z.object({
  id: z.string().uuid(),
  automation_id: z.string().uuid(),
  status: z.string(),
  started_at: z.string(),
  finished_at: z.string().nullable().optional(),
}).passthrough();

export function registerBoltTools(server: McpServer, api: ApiClient, boltApiUrl: string): void {
  const client = createBoltClient(boltApiUrl, api);

  /**
   * Resolve an automation identifier that may be either a UUID or a human
   * automation name to a UUID. Delegates to the `by-name` resolver endpoint
   * added in Phase C. Returns `null` on miss so callers can surface a clean
   * "Automation not found" error.
   */
  async function resolveAutomationId(nameOrId: string): Promise<string | null> {
    if (isUuid(nameOrId)) return nameOrId;
    const result = await client.request(
      'GET',
      `/automations/by-name/${encodeURIComponent(nameOrId)}`,
    );
    if (!result.ok) return null;
    const envelope = result.data as { data?: { id?: string } | null } | null;
    return envelope?.data?.id ?? null;
  }

  function automationNotFound(nameOrId: string) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Automation not found: "${nameOrId}". Provide a UUID or the automation's exact name.`,
        },
      ],
      isError: true as const,
    };
  }

  // ===== AUTOMATIONS CRUD (7) =====

  registerTool(server, {
    name: 'bolt_list',
    description: 'List workflow automations with optional filters and pagination.',
    input: {
      project_id: z.string().uuid().optional().describe('Filter by project'),
      trigger_source: z.enum(['bam', 'banter', 'beacon', 'brief', 'helpdesk', 'schedule', 'bond', 'blast', 'board', 'bench', 'bearing', 'bill', 'book', 'blank']).optional().describe('Filter by trigger source'),
      enabled: z.boolean().optional().describe('Filter by enabled state'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(100).optional().describe('Page size (default 50, max 100)'),
    },
    returns: z.object({ data: z.array(automationShape), next_cursor: z.string().nullable().optional() }),
    handler: async (params) => {
      const result = await client.request('GET', `/automations${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing automations', result.data);
    },
  });

  registerTool(server, {
    name: 'bolt_get',
    description: 'Get a single automation with its conditions and actions.',
    input: {
      id: z.string().min(1).describe('Automation UUID or exact automation name'),
    },
    returns: automationShape.extend({ conditions: z.array(z.record(z.unknown())).optional(), actions: z.array(z.record(z.unknown())).optional() }),
    handler: async ({ id }) => {
      const resolvedId = await resolveAutomationId(id);
      if (!resolvedId) return automationNotFound(id);
      const result = await client.request('GET', `/automations/${resolvedId}`);
      return result.ok ? ok(result.data) : err('getting automation', result.data);
    },
  });

  registerTool(server, {
    name: 'bolt_get_automation_by_name',
    description: 'Resolve an automation by its name within the caller\'s org. Case-insensitive exact match is preferred; falls back to a single-hit fuzzy ILIKE "%name%" match. Returns a compact projection ({ id, name, description, trigger_source, trigger_event, enabled, action_count, last_execution_at }) or null if no unique match is found. Useful for meta-automations that need to reference other automations by name (e.g. disable the "Nightly Deploys" automation when an incident is declared).',
    input: {
      name: z.string().min(1).max(255).describe('Automation name to resolve (case-insensitive)'),
    },
    returns: z.object({
      data: automationShape.extend({
        action_count: z.number().optional(),
        last_execution_at: z.string().nullable().optional(),
      }).nullable(),
    }).passthrough(),
    handler: async ({ name }) => {
      const encoded = encodeURIComponent(name);
      const result = await client.request('GET', `/automations/by-name/${encoded}`);
      return result.ok ? ok(result.data) : err('resolving automation by name', result.data);
    },
  });

  registerTool(server, {
    name: 'bolt_create',
    description: 'Create a new workflow automation with trigger, conditions, and actions.',
    input: {
      name: z.string().max(255).describe('Automation name (max 255 chars)'),
      description: z.string().max(2000).optional().describe('Description (max 2000 chars)'),
      project_id: z.string().uuid().optional().describe('Project to scope the automation to'),
      trigger_source: z.enum(['bam', 'banter', 'beacon', 'brief', 'helpdesk', 'schedule', 'bond', 'blast', 'board', 'bench', 'bearing', 'bill', 'book', 'blank']).describe('Source system that fires the trigger'),
      trigger_event: z.string().max(60).describe('Event name within the source (max 60 chars)'),
      trigger_filter: z.record(z.unknown()).optional().describe('Optional filter object narrowing which events match'),
      conditions: z.array(z.record(z.unknown())).optional().describe('Array of condition objects that must all pass'),
      actions: z.array(z.record(z.unknown())).min(1).describe('Array of action objects to execute (min 1)'),
      max_executions_per_hour: z.number().int().positive().optional().describe('Rate limit per hour (default 100)'),
      cooldown_seconds: z.number().int().min(0).optional().describe('Minimum seconds between executions (default 0)'),
      enabled: z.boolean().optional().describe('Whether the automation is active (default true)'),
    },
    returns: automationShape,
    handler: async (params) => {
      const result = await client.request('POST', '/automations', params);
      return result.ok ? ok(result.data) : err('creating automation', result.data);
    },
  });

  registerTool(server, {
    name: 'bolt_update',
    description: 'Update an existing automation. Provide only the fields to change.',
    input: {
      id: z.string().min(1).describe('Automation UUID or exact automation name'),
      name: z.string().max(255).optional().describe('Updated name'),
      description: z.string().max(2000).optional().describe('Updated description'),
      trigger_source: z.enum(['bam', 'banter', 'beacon', 'brief', 'helpdesk', 'schedule', 'bond', 'blast', 'board', 'bench', 'bearing', 'bill', 'book', 'blank']).optional().describe('Updated trigger source'),
      trigger_event: z.string().max(60).optional().describe('Updated trigger event'),
      trigger_filter: z.record(z.unknown()).optional().describe('Updated trigger filter'),
      conditions: z.array(z.record(z.unknown())).optional().describe('Updated conditions array'),
      actions: z.array(z.record(z.unknown())).optional().describe('Updated actions array'),
      enabled: z.boolean().optional().describe('Enable or disable'),
    },
    returns: automationShape,
    handler: async ({ id, ...body }) => {
      const resolvedId = await resolveAutomationId(id);
      if (!resolvedId) return automationNotFound(id);
      const result = await client.request('PUT', `/automations/${resolvedId}`, body);
      return result.ok ? ok(result.data) : err('updating automation', result.data);
    },
  });

  registerTool(server, {
    name: 'bolt_enable',
    description: 'Enable a workflow automation.',
    input: {
      id: z.string().min(1).describe('Automation UUID or exact automation name (e.g. "Nightly Deploys")'),
    },
    returns: automationShape,
    handler: async ({ id }) => {
      const resolvedId = await resolveAutomationId(id);
      if (!resolvedId) return automationNotFound(id);
      const result = await client.request('POST', `/automations/${resolvedId}/enable`);
      return result.ok ? ok(result.data) : err('enabling automation', result.data);
    },
  });

  registerTool(server, {
    name: 'bolt_disable',
    description: 'Disable a workflow automation.',
    input: {
      id: z.string().min(1).describe('Automation UUID or exact automation name (e.g. "Nightly Deploys")'),
    },
    returns: automationShape,
    handler: async ({ id }) => {
      const resolvedId = await resolveAutomationId(id);
      if (!resolvedId) return automationNotFound(id);
      const result = await client.request('POST', `/automations/${resolvedId}/disable`);
      return result.ok ? ok(result.data) : err('disabling automation', result.data);
    },
  });

  registerTool(server, {
    name: 'bolt_delete',
    description: 'Delete a workflow automation.',
    input: {
      id: z.string().min(1).describe('Automation UUID or exact automation name'),
    },
    returns: z.object({ ok: z.boolean() }),
    handler: async ({ id }) => {
      const resolvedId = await resolveAutomationId(id);
      if (!resolvedId) return automationNotFound(id);
      const result = await client.request('DELETE', `/automations/${resolvedId}`);
      return result.ok ? ok(result.data) : err('deleting automation', result.data);
    },
  });

  // ===== TESTING (1) =====

  registerTool(server, {
    name: 'bolt_test',
    description:
      'Dry-run an automation against a simulated event payload. This evaluates ONLY the automation\'s conditions against the event — it does NOT execute the actions. Use it to check whether a given event would (or would not) trigger the automation. Returns `passed` (would the actions run), a per-condition `log`, and a human-readable `message`. To actually run actions, the automation must fire on a real ingested event.',
    input: {
      id: z.string().min(1).describe('Automation UUID or exact automation name to test'),
      event: z.record(z.unknown()).describe('Simulated event payload object'),
    },
    returns: z
      .object({
        ok: z.boolean(),
        // Whether the conditions matched, i.e. the actions WOULD execute on a
        // real event with this payload. Actions are not run by this tool.
        passed: z.boolean().optional(),
        // Per-condition evaluation detail (field/operator/expected/actual/result).
        log: z
          .array(
            z.object({
              field: z.string(),
              operator: z.string(),
              expected: z.unknown(),
              actual: z.unknown(),
              result: z.boolean(),
            }),
          )
          .optional(),
        message: z.string().optional(),
        error: z.string().optional(),
      })
      .passthrough(),
    handler: async ({ id, event }) => {
      const resolvedId = await resolveAutomationId(id);
      if (!resolvedId) return automationNotFound(id);
      const result = await client.request('POST', `/automations/${resolvedId}/test`, { event });
      return result.ok ? ok(result.data) : err('testing automation', result.data);
    },
  });

  // ===== EXECUTIONS (2) =====

  registerTool(server, {
    name: 'bolt_executions',
    description: 'List execution history for an automation.',
    input: {
      automation_id: z.string().min(1).describe('Automation UUID or exact automation name'),
      status: z.enum(['running', 'success', 'partial', 'failed', 'skipped']).optional().describe('Filter by execution status'),
      limit: z.number().int().positive().max(100).optional().describe('Max results (default 50, max 100)'),
    },
    returns: z.object({ data: z.array(executionShape) }),
    handler: async ({ automation_id, ...rest }) => {
      const resolvedId = await resolveAutomationId(automation_id);
      if (!resolvedId) return automationNotFound(automation_id);
      const result = await client.request('GET', `/automations/${resolvedId}/executions${buildQs(rest)}`);
      return result.ok ? ok(result.data) : err('listing executions', result.data);
    },
  });

  registerTool(server, {
    name: 'bolt_execution_detail',
    description: 'Get detailed information about a single execution, including action results.',
    input: {
      id: z.string().uuid().describe('Execution ID'),
    },
    returns: executionShape.extend({ action_results: z.array(z.record(z.unknown())).optional() }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/executions/${id}`);
      return result.ok ? ok(result.data) : err('getting execution detail', result.data);
    },
  });

  // ===== DISCOVERY (2) =====

  registerTool(server, {
    name: 'bolt_events',
    description: 'List available trigger events, optionally filtered by source.',
    input: {
      source: z.enum(['bam', 'banter', 'beacon', 'brief', 'helpdesk', 'schedule', 'bond', 'blast', 'board', 'bench', 'bearing', 'bill', 'book', 'blank']).optional().describe('Filter events by source system'),
    },
    returns: z.object({ data: z.array(z.object({ source: z.string(), event: z.string(), description: z.string().optional() }).passthrough()) }),
    handler: async ({ source }) => {
      const path = source ? `/events/${source}` : '/events';
      const result = await client.request('GET', path);
      return result.ok ? ok(result.data) : err('listing events', result.data);
    },
  });

  registerTool(server, {
    name: 'bolt_actions',
    description: 'List available MCP tools that can be used as automation actions.',
    input: {},
    returns: z.object({ data: z.array(z.record(z.unknown())) }).passthrough(),
    handler: async () => {
      const result = await client.request('GET', '/actions');
      return result.ok ? ok(result.data) : err('listing actions', result.data);
    },
  });

  // ===== STATS (1) =====

  registerTool(server, {
    name: 'bolt_stats',
    description: 'Get aggregate automation statistics for the org (totals, enabled count, execution counts). Pass project_id to scope the numbers to a single project so they line up with a filtered list view.',
    input: {
      project_id: z.string().uuid().optional().describe('Scope stats to a single project'),
    },
    returns: z.object({ data: z.object({}).passthrough() }).passthrough(),
    handler: async (params) => {
      const result = await client.request('GET', `/automations/stats${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('getting automation stats', result.data);
    },
  });

  // ===== PARTIAL UPDATE (1) =====

  registerTool(server, {
    name: 'bolt_patch',
    description: 'Partial metadata update of an automation. Only touches name, description, and/or enabled — does not modify the trigger, conditions, or actions (use bolt_update for those). Provide only the fields to change.',
    input: {
      id: z.string().min(1).describe('Automation UUID or exact automation name'),
      name: z.string().min(1).max(255).optional().describe('Updated name'),
      description: z.string().max(5000).nullable().optional().describe('Updated description (null to clear)'),
      enabled: z.boolean().optional().describe('Enable or disable'),
    },
    returns: automationShape,
    handler: async ({ id, ...body }) => {
      const resolvedId = await resolveAutomationId(id);
      if (!resolvedId) return automationNotFound(id);
      const result = await client.request('PATCH', `/automations/${resolvedId}`, body);
      return result.ok ? ok(result.data) : err('patching automation', result.data);
    },
  });

  // ===== DUPLICATE (1) =====

  registerTool(server, {
    name: 'bolt_duplicate',
    description: 'Duplicate an automation. Creates a disabled copy (with its conditions and actions) under a new name so you can safely modify it before enabling.',
    input: {
      id: z.string().min(1).describe('Automation UUID or exact automation name to duplicate'),
    },
    returns: automationShape,
    handler: async ({ id }) => {
      const resolvedId = await resolveAutomationId(id);
      if (!resolvedId) return automationNotFound(id);
      const result = await client.request('POST', `/automations/${resolvedId}/duplicate`);
      return result.ok ? ok(result.data) : err('duplicating automation', result.data);
    },
  });

  // ===== VERSIONS (2) =====

  registerTool(server, {
    name: 'bolt_list_versions',
    description: 'List the saved version history for an automation. Each version is a point-in-time snapshot of the trigger, conditions, and actions captured on update/restore.',
    input: {
      id: z.string().min(1).describe('Automation UUID or exact automation name'),
    },
    returns: z.object({ data: z.array(z.object({ id: z.string().uuid(), automation_id: z.string().uuid(), created_at: z.string() }).passthrough()) }),
    handler: async ({ id }) => {
      const resolvedId = await resolveAutomationId(id);
      if (!resolvedId) return automationNotFound(id);
      const result = await client.request('GET', `/automations/${resolvedId}/versions`);
      return result.ok ? ok(result.data) : err('listing automation versions', result.data);
    },
  });

  registerTool(server, {
    name: 'bolt_restore_version',
    description: 'Restore an automation to a previously saved version. The current state is snapshotted first, then the named version becomes the live definition.',
    input: {
      id: z.string().min(1).describe('Automation UUID or exact automation name'),
      version_id: z.string().uuid().describe('Version UUID to restore (from bolt_list_versions)'),
    },
    returns: automationShape,
    handler: async ({ id, version_id }) => {
      const resolvedId = await resolveAutomationId(id);
      if (!resolvedId) return automationNotFound(id);
      const result = await client.request('POST', `/automations/${resolvedId}/versions/${version_id}/restore`);
      return result.ok ? ok(result.data) : err('restoring automation version', result.data);
    },
  });

  // ===== ORG-WIDE EXECUTIONS (1) + RETRY (1) =====

  registerTool(server, {
    name: 'bolt_list_executions',
    description: 'List execution history across all automations in the org (not scoped to a single automation — use bolt_executions for that). Org-admin scoped.',
    input: {
      status: z.enum(['running', 'success', 'partial', 'failed', 'skipped']).optional().describe('Filter by execution status'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(100).optional().describe('Page size (default per server, max 100)'),
    },
    returns: z.object({ data: z.array(executionShape), next_cursor: z.string().nullable().optional() }),
    handler: async (params) => {
      const result = await client.request('GET', `/executions${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing org executions', result.data);
    },
  });

  registerTool(server, {
    name: 'bolt_retry_execution',
    description: 'Retry a failed (or partial) execution. Re-runs the automation against the original event payload and creates a new execution row.',
    input: {
      id: z.string().uuid().describe('Execution UUID to retry (from bolt_executions / bolt_list_executions)'),
    },
    returns: executionShape,
    handler: async ({ id }) => {
      const result = await client.request('POST', `/executions/${id}/retry`);
      return result.ok ? ok(result.data) : err('retrying execution', result.data);
    },
  });

  // ===== TEMPLATES (2) =====

  registerTool(server, {
    name: 'bolt_list_templates',
    description: 'List the built-in automation templates available for instantiation (pre-built trigger/condition/action blueprints).',
    input: {},
    returns: z.object({ data: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()) }),
    handler: async () => {
      const result = await client.request('GET', '/templates');
      return result.ok ? ok(result.data) : err('listing templates', result.data);
    },
  });

  registerTool(server, {
    name: 'bolt_instantiate_template',
    description: 'Create a new automation from a built-in template (see bolt_list_templates for ids). Optional overrides let you set the name, description, project, and cron schedule on the new automation.',
    input: {
      template_id: z.string().min(1).describe('Template id from bolt_list_templates'),
      name: z.string().min(1).max(255).optional().describe('Override the automation name'),
      description: z.string().max(5000).nullable().optional().describe('Override the description'),
      project_id: z.string().uuid().nullable().optional().describe('Scope the new automation to a project'),
      cron_expression: z.string().max(100).nullable().optional().describe('Cron expression (for schedule-triggered templates)'),
      cron_timezone: z.string().max(50).optional().describe('Cron timezone (e.g. "UTC", "America/New_York")'),
    },
    returns: automationShape,
    handler: async ({ template_id, ...overrides }) => {
      const result = await client.request('POST', `/templates/${encodeURIComponent(template_id)}/instantiate`, overrides);
      return result.ok ? ok(result.data) : err('instantiating template', result.data);
    },
  });

  // ===== AI ASSIST (2) =====

  registerTool(server, {
    name: 'bolt_generate',
    description: 'Generate a draft automation definition from a natural-language prompt using the org\'s configured LLM provider. Returns a proposed automation object (name, trigger, conditions, actions) plus a confidence score; it does NOT persist anything — pass the result to bolt_create to save it. Requires an LLM provider to be configured (returns AI_NOT_CONFIGURED otherwise).',
    input: {
      prompt: z.string().min(1).max(2000).describe('Natural-language description of the desired automation'),
      context: z.record(z.unknown()).optional().describe('Optional context object to ground the generation'),
      project_id: z.string().uuid().optional().describe('Project to resolve the LLM provider against and scope the draft'),
    },
    returns: z.object({ data: z.object({ automation: z.object({}).passthrough(), confidence: z.number().optional() }).passthrough() }).passthrough(),
    handler: async (params) => {
      const result = await client.request('POST', '/ai/generate', params);
      return result.ok ? ok(result.data) : err('generating automation', result.data);
    },
  });

  registerTool(server, {
    name: 'bolt_explain',
    description: 'Explain an automation definition in plain English using the org\'s configured LLM provider. Pass the automation shape (name, trigger_source, trigger_event, conditions, actions) — for an existing automation, fetch it with bolt_get first. Returns a natural-language explanation. Requires an LLM provider to be configured (returns AI_NOT_CONFIGURED otherwise).',
    input: {
      automation: z.object({
        name: z.string().max(255).describe('Automation name'),
        trigger_source: z.string().max(30).describe('Trigger source system'),
        trigger_event: z.string().max(60).describe('Trigger event name'),
        conditions: z.array(z.record(z.unknown())).optional().describe('Condition objects'),
        actions: z.array(z.record(z.unknown())).optional().describe('Action objects'),
      }).describe('The automation definition to explain'),
      project_id: z.string().uuid().optional().describe('Project to resolve the LLM provider against'),
    },
    returns: z.object({ data: z.object({ explanation: z.string() }).passthrough() }).passthrough(),
    handler: async (params) => {
      const result = await client.request('POST', '/ai/explain', params);
      return result.ok ? ok(result.data) : err('explaining automation', result.data);
    },
  });
}
