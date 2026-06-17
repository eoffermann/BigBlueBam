import { registerTool } from '../lib/register-tool.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { isUuid } from '../middleware/resolve-helpers.js';

/**
 * Helper to make requests to the bearing-api service.
 * Same pattern as bolt-tools.ts — a lightweight fetch wrapper that targets
 * the bearing-api base URL and forwards the user's auth token.
 */
function createBearingClient(bearingApiUrl: string, api: ApiClient) {
  const baseUrl = bearingApiUrl.replace(/\/$/, '');

  async function request(method: string, path: string, body?: unknown) {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {};

    // Forward the bearer token from the main API client
    const token = (api as unknown as { token?: string }).token;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    // Forward org context
    const orgId = (api as unknown as { orgId?: string }).orgId;
    if (orgId) {
      headers['X-Org-Id'] = orgId;
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

type BearingClient = ReturnType<typeof createBearingClient>;

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

// ---------------------------------------------------------------------------
// Name-or-ID resolvers (Phase D / Tier 3)
// ---------------------------------------------------------------------------
//
// Rule authors write Bearing rules in terms of what a human recognizes —
// "bump the Revenue KR", "update the Q2 2026 planning goal", "assign to
// alice@example.com" — not opaque UUIDs. These resolvers let the canonical
// action tools take either a UUID (fast path, zero extra HTTP) or a
// human-readable identifier (single lookup via the existing list endpoints).
//
// Contract for all resolvers:
//   - UUID input → returned verbatim, no HTTP call
//   - name/label/email input → single (or bounded) lookup, exact match
//     preferred, single fuzzy match acceptable, multiple fuzzy matches
//     → return null so the caller can emit a disambiguation error
//   - null return = not found, caller formats the user-facing error

async function resolveGoalId(
  bearing: BearingClient,
  nameOrId: string,
): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;
  // The /goals list endpoint supports ?search=, which does an ilike match
  // against title + description in the goal service.
  const result = await bearing.request(
    'GET',
    `/goals?search=${encodeURIComponent(nameOrId)}&limit=10`,
  );
  if (!result.ok) {
    // Fallback: list all goals (bounded) and filter client-side. This covers
    // the case where the search index is down or the search param parser
    // rejects something unusual.
    const all = await bearing.request('GET', '/goals?limit=100');
    if (!all.ok) return null;
    const goals = (all.data as { data: Array<{ id: string; title: string }> }).data ?? [];
    const match = goals.find((g) => g.title.toLowerCase() === nameOrId.toLowerCase());
    return match?.id ?? null;
  }
  const goals = (result.data as { data: Array<{ id: string; title: string }> }).data ?? [];
  const exact = goals.find((g) => g.title.toLowerCase() === nameOrId.toLowerCase());
  if (exact) return exact.id;
  if (goals.length === 1 && goals[0]) return goals[0].id;
  return null;
}

/**
 * Resolve a key-result identifier by title. There is no top-level KR listing
 * endpoint in bearing-api (only `/goals/:id/key-results`), so we walk the
 * most recent goals and look for a KR whose title matches the needle.
 *
 * This is best-effort: we bound the walk at 50 goals (sized to cover the
 * typical org's active period) to avoid unbounded latency. A UUID input
 * short-circuits before any HTTP call, so existing rules pay nothing.
 *
 * Returns null if not found, or if multiple KRs match the needle — the
 * caller should surface a "disambiguate please" error in that case.
 */
async function resolveKeyResultId(
  bearing: BearingClient,
  nameOrId: string,
): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;

  const needle = nameOrId.toLowerCase();

  // List the 50 most recent goals in the active org.
  const goalsResult = await bearing.request('GET', '/goals?limit=50');
  if (!goalsResult.ok) return null;
  const goals = (goalsResult.data as { data: Array<{ id: string }> }).data ?? [];

  // Walk each goal's KRs and collect matches.
  // We do these sequentially rather than in parallel to keep the blast
  // radius of a mistyped title small — if the first goal has a KR with the
  // exact title we stop immediately.
  const exactMatches: Array<{ id: string; title: string }> = [];
  const fuzzyMatches: Array<{ id: string; title: string }> = [];

  for (const goal of goals) {
    const krResult = await bearing.request('GET', `/goals/${goal.id}/key-results`);
    if (!krResult.ok) continue;
    const krs = (krResult.data as { data: Array<{ id: string; title: string }> }).data ?? [];
    for (const kr of krs) {
      const title = kr.title.toLowerCase();
      if (title === needle) {
        exactMatches.push(kr);
      } else if (title.includes(needle)) {
        fuzzyMatches.push(kr);
      }
    }
    // Short-circuit on a unique exact match as soon as we've walked enough
    // to be confident — if we've already seen >1 exact match we know we
    // need to fail with disambiguation regardless.
    if (exactMatches.length > 1) return null;
  }

  if (exactMatches.length === 1 && exactMatches[0]) return exactMatches[0].id;
  if (exactMatches.length > 1) return null;
  if (fuzzyMatches.length === 1 && fuzzyMatches[0]) return fuzzyMatches[0].id;
  return null;
}

async function resolvePeriodId(
  bearing: BearingClient,
  labelOrId: string,
): Promise<string | null> {
  if (isUuid(labelOrId)) return labelOrId;
  // There is no /periods/by-label endpoint; `name` is the label column on
  // bearing_periods (e.g. "Q2 2026"). Fetch a bounded page and match.
  const result = await bearing.request('GET', '/periods?limit=100');
  if (!result.ok) return null;
  const periods = (result.data as { data: Array<{ id: string; name: string }> }).data ?? [];
  const needle = labelOrId.toLowerCase();
  const exact = periods.find((p) => p.name.toLowerCase() === needle);
  if (exact) return exact.id;
  // Single substring match acceptable ("Q2" → "Q2 2026" if that's the only
  // hit), otherwise fail so the caller can disambiguate.
  const fuzzy = periods.filter((p) => p.name.toLowerCase().includes(needle));
  if (fuzzy.length === 1 && fuzzy[0]) return fuzzy[0].id;
  return null;
}

/**
 * Resolve a user identifier (UUID, email, or free-text name) to a UUID via
 * the shared Bam users table. Uses the main `api` client, not the bearing
 * client, because bearing-api has no user endpoint — users live in the Bam
 * API and are shared across all apps in the suite.
 */
async function resolveOwnerId(api: ApiClient, idOrEmail: string): Promise<string | null> {
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

const goalShape = z.object({
  id: z.string().uuid(),
  title: z.string(),
  status: z.string().optional(),
  scope: z.string().optional(),
  owner_id: z.string().uuid().optional(),
  period_id: z.string().uuid().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

const krShape = z.object({
  id: z.string().uuid(),
  title: z.string(),
  goal_id: z.string().uuid(),
  current_value: z.number().optional(),
  target_value: z.number(),
  metric_type: z.string().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

export function registerBearingTools(server: McpServer, api: ApiClient, bearingApiUrl: string): void {
  const client = createBearingClient(bearingApiUrl, api);

  // ===== PERIODS (2) =====

  registerTool(server, {
    name: 'bearing_periods',
    description: 'List OKR periods with optional filters by status and year.',
    input: {
      status: z.enum(['planning', 'active', 'completed']).optional().describe('Filter by period status'),
      year: z.number().int().optional().describe('Filter by year'),
    },
    returns: z.object({ data: z.array(z.object({ id: z.string().uuid(), name: z.string(), status: z.string(), year: z.number().optional() }).passthrough()) }),
    handler: async (params) => {
      const result = await client.request('GET', `/periods${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing periods', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_period_get',
    description: 'Get a single OKR period with aggregated stats.',
    input: {
      id: z.string().uuid().describe('Period ID'),
    },
    returns: z.object({ id: z.string().uuid(), name: z.string(), status: z.string(), goal_count: z.number().optional() }).passthrough(),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/periods/${id}`);
      return result.ok ? ok(result.data) : err('getting period', result.data);
    },
  });

  // ===== GOALS (4) =====

  registerTool(server, {
    name: 'bearing_goals',
    description: 'List OKR goals with optional filters by period, scope, owner, and status.',
    input: {
      period_id: z.string().uuid().optional().describe('Filter by period'),
      scope: z.enum(['organization', 'team', 'project', 'individual']).optional().describe('Filter by goal scope'),
      owner_id: z.string().uuid().optional().describe('Filter by goal owner'),
      status: z.enum(['draft', 'on_track', 'at_risk', 'behind', 'achieved', 'missed']).optional().describe('Filter by goal status'),
      limit: z.number().int().positive().max(100).optional().describe('Max results (default 50, max 100)'),
    },
    returns: z.object({ data: z.array(goalShape) }),
    handler: async (params) => {
      const result = await client.request('GET', `/goals${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing goals', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_goal_get',
    description: 'Get a single goal with its key results and progress details.',
    input: {
      id: z.string().uuid().describe('Goal ID'),
    },
    returns: goalShape.extend({ key_results: z.array(krShape).optional() }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/goals/${id}`);
      return result.ok ? ok(result.data) : err('getting goal', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_goal_create',
    description: 'Create a new OKR goal within a period. `period_id` accepts either a UUID or the period label (e.g. "Q2 2026"). `owner_id` accepts a UUID or the owner\'s email address.',
    input: {
      period_id: z.string().describe('Period UUID or period label (e.g. "Q2 2026")'),
      title: z.string().max(255).describe('Goal title (max 255 chars)'),
      description: z.string().max(2000).optional().describe('Goal description (max 2000 chars)'),
      scope: z.enum(['organization', 'team', 'project', 'individual']).optional().describe('Goal scope level'),
      project_id: z.string().uuid().optional().describe('Project to scope the goal to (when scope is project)'),
      team_name: z.string().max(100).optional().describe('Team name (when scope is team)'),
      icon: z.string().max(50).optional().describe('Icon identifier'),
      color: z.string().max(20).optional().describe('Color value (hex or named)'),
      owner_id: z.string().describe('Goal owner: user UUID or email address'),
    },
    returns: goalShape,
    handler: async (params) => {
      const period_id = await resolvePeriodId(client, params.period_id);
      if (!period_id) {
        return err('creating goal', {
          message: `Period not found by label or id: ${params.period_id}`,
        });
      }

      const owner_id = await resolveOwnerId(api, params.owner_id);
      if (!owner_id) {
        return err('creating goal', {
          message: `Owner not found by email or id: ${params.owner_id}`,
        });
      }

      const body = { ...params, period_id, owner_id };
      const result = await client.request('POST', '/goals', body);
      return result.ok ? ok(result.data) : err('creating goal', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_goal_update',
    description: 'Update an existing goal. Provide only the fields to change. `id` accepts either a UUID or the goal title. `owner_id` accepts a UUID or email address.',
    input: {
      id: z.string().describe('Goal UUID or goal title'),
      title: z.string().max(255).optional().describe('Updated title'),
      description: z.string().max(2000).optional().describe('Updated description'),
      scope: z.enum(['organization', 'team', 'project', 'individual']).optional().describe('Updated scope'),
      owner_id: z.string().optional().describe('Updated owner: user UUID or email address'),
      icon: z.string().max(50).optional().describe('Updated icon'),
      color: z.string().max(20).optional().describe('Updated color'),
    },
    returns: goalShape,
    handler: async ({ id, ...rest }) => {
      const goalId = await resolveGoalId(client, id);
      if (!goalId) {
        return err('updating goal', {
          message: `Goal not found by title or id: ${id}`,
        });
      }

      const body: Record<string, unknown> = { ...rest };
      if (rest.owner_id !== undefined) {
        const resolved = await resolveOwnerId(api, rest.owner_id);
        if (!resolved) {
          return err('updating goal', {
            message: `Owner not found by email or id: ${rest.owner_id}`,
          });
        }
        body.owner_id = resolved;
      }

      const result = await client.request('PATCH', `/goals/${goalId}`, body);
      return result.ok ? ok(result.data) : err('updating goal', result.data);
    },
  });

  // ===== KEY RESULTS (3) =====

  registerTool(server, {
    name: 'bearing_kr_create',
    description: 'Create a key result under a goal. `goal_id` accepts a UUID or the goal title. `owner_id` accepts a UUID or email address.',
    input: {
      goal_id: z.string().describe('Parent goal UUID or goal title'),
      title: z.string().max(255).describe('Key result title (max 255 chars)'),
      description: z.string().max(2000).optional().describe('Key result description'),
      metric_type: z.enum(['number', 'percentage', 'currency', 'boolean']).optional().describe('Metric type'),
      target_value: z.number().describe('Target value to achieve'),
      start_value: z.number().optional().describe('Starting value (default 0)'),
      unit: z.string().max(20).optional().describe('Unit label (e.g. "users", "$", "%")'),
      direction: z.enum(['increase', 'decrease']).optional().describe('Whether the metric should increase or decrease'),
      progress_mode: z.enum(['manual', 'linked']).optional().describe('How progress is tracked'),
      owner_id: z.string().optional().describe('Key result owner: user UUID or email (defaults to goal owner)'),
    },
    returns: krShape,
    handler: async ({ goal_id, owner_id, ...body }) => {
      const goalId = await resolveGoalId(client, goal_id);
      if (!goalId) {
        return err('creating key result', {
          message: `Goal not found by title or id: ${goal_id}`,
        });
      }

      const resolvedBody: Record<string, unknown> = { ...body };
      if (owner_id !== undefined) {
        const resolved = await resolveOwnerId(api, owner_id);
        if (!resolved) {
          return err('creating key result', {
            message: `Owner not found by email or id: ${owner_id}`,
          });
        }
        resolvedBody.owner_id = resolved;
      }

      const result = await client.request('POST', `/goals/${goalId}/key-results`, resolvedBody);
      return result.ok ? ok(result.data) : err('creating key result', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_kr_update',
    description: 'Update a key result value or metadata. When current_value is provided, also records a value check-in. `id` accepts either a UUID or the KR title — if multiple KRs share the title the tool fails and asks for disambiguation.',
    input: {
      id: z.string().describe('Key result UUID or KR title'),
      current_value: z.number().optional().describe('New current value (also posts a value check-in)'),
      title: z.string().max(255).optional().describe('Updated title'),
      target_value: z.number().optional().describe('Updated target value'),
    },
    returns: krShape,
    handler: async ({ id, current_value, ...metaBody }) => {
      const krId = await resolveKeyResultId(client, id);
      if (!krId) {
        return err('updating key result', {
          message: `Key result not found by title or id: ${id}. If the title is shared across multiple goals, please pass the UUID or narrow the search with bearing_goal_get first.`,
        });
      }

      // Update metadata if any meta fields provided
      const hasMeta = Object.values(metaBody).some((v) => v !== undefined);
      if (hasMeta) {
        const metaResult = await client.request('PATCH', `/key-results/${krId}`, metaBody);
        if (!metaResult.ok) return err('updating key result', metaResult.data);
      }

      // Post value check-in if current_value provided
      if (current_value !== undefined) {
        const valueResult = await client.request('POST', `/key-results/${krId}/value`, { value: current_value });
        if (!valueResult.ok) return err('recording key result value', valueResult.data);
        return ok(valueResult.data);
      }

      // If only meta was updated, fetch the updated KR
      const getResult = await client.request('GET', `/key-results/${krId}`);
      return getResult.ok ? ok(getResult.data) : err('fetching updated key result', getResult.data);
    },
  });

  registerTool(server, {
    name: 'bearing_kr_link',
    description: 'Link a key result to a Bam entity (epic, project, or task query) for automatic progress tracking. `key_result_id` accepts a UUID or the KR title.',
    input: {
      key_result_id: z.string().describe('Key result UUID or KR title'),
      link_type: z.enum(['epic', 'project', 'task_query', 'task', 'sprint']).describe('Type of entity to link'),
      target_type: z.enum(['task', 'epic', 'project', 'sprint', 'goal']).describe('Type of target entity'),
      target_id: z.string().uuid().describe('Target entity ID'),
      metadata: z.record(z.unknown()).optional().describe('Optional metadata for this link'),
    },
    returns: z.object({ id: z.string().uuid(), key_result_id: z.string().uuid(), target_id: z.string().uuid() }).passthrough(),
    handler: async ({ key_result_id, ...body }) => {
      const krId = await resolveKeyResultId(client, key_result_id);
      if (!krId) {
        return err('linking key result', {
          message: `Key result not found by title or id: ${key_result_id}. If the title is shared across multiple goals, please pass the UUID.`,
        });
      }
      const result = await client.request('POST', `/key-results/${krId}/links`, body);
      return result.ok ? ok(result.data) : err('linking key result', result.data);
    },
  });

  // ===== UPDATES (1) =====

  registerTool(server, {
    name: 'bearing_update_post',
    description: 'Post a status update on a goal. `goal_id` accepts a UUID or the goal title.',
    input: {
      goal_id: z.string().describe('Goal UUID or goal title'),
      status: z.enum(['draft', 'on_track', 'at_risk', 'behind', 'achieved', 'missed']).describe('Goal status for this update'),
      body: z.string().max(5000).optional().describe('Update body text (max 5000 chars)'),
    },
    returns: z.object({ id: z.string().uuid(), goal_id: z.string().uuid(), status: z.string(), created_at: z.string() }).passthrough(),
    handler: async ({ goal_id, status, body: updateBody }) => {
      const goalId = await resolveGoalId(client, goal_id);
      if (!goalId) {
        return err('posting goal update', {
          message: `Goal not found by title or id: ${goal_id}`,
        });
      }
      const result = await client.request('POST', `/goals/${goalId}/updates`, { status, body: updateBody });
      return result.ok ? ok(result.data) : err('posting goal update', result.data);
    },
  });

  // ===== REPORTS (2) =====

  registerTool(server, {
    name: 'bearing_report',
    description: 'Generate a period summary, at-risk, or owner report.',
    input: {
      report_type: z.enum(['period', 'at_risk', 'owner']).describe('Type of report to generate'),
      period_id: z.string().uuid().optional().describe('Period ID (required for period reports)'),
      user_id: z.string().uuid().optional().describe('User ID (required for owner reports)'),
      format: z.enum(['markdown', 'json']).optional().describe('Output format (default json)'),
    },
    returns: z.object({}).passthrough().describe('Report data — shape varies by report_type'),
    handler: async ({ report_type, period_id, user_id, format }) => {
      let path: string;
      const qs = buildQs({ format });

      switch (report_type) {
        case 'period':
          if (!period_id) {
            return err('generating report', { message: 'period_id is required for period reports' });
          }
          path = `/reports/period/${period_id}${qs}`;
          break;
        case 'at_risk':
          path = `/reports/at-risk${qs}`;
          break;
        case 'owner':
          if (!user_id) {
            return err('generating report', { message: 'user_id is required for owner reports' });
          }
          path = `/reports/owner/${user_id}${qs}`;
          break;
      }

      const result = await client.request('GET', path);
      return result.ok ? ok(result.data) : err('generating report', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_at_risk',
    description: 'Quick check: list all at-risk or behind goals across the organization.',
    input: {},
    returns: z.object({ data: z.array(goalShape) }),
    handler: async () => {
      const result = await client.request('GET', '/reports/at-risk');
      return result.ok ? ok(result.data) : err('fetching at-risk goals', result.data);
    },
  });

  // ===== GOALS — additional (delete / status override / updates / watchers / history) =====

  registerTool(server, {
    name: 'bearing_goal_delete',
    description: 'Delete a goal and its key results. `id` accepts either a UUID or the goal title.',
    input: {
      id: z.string().describe('Goal UUID or goal title'),
    },
    returns: z.object({ deleted: z.literal(true), id: z.string().uuid() }),
    handler: async ({ id }) => {
      const goalId = await resolveGoalId(client, id);
      if (!goalId) {
        return err('deleting goal', { message: `Goal not found by title or id: ${id}` });
      }
      const result = await client.request('DELETE', `/goals/${goalId}`);
      return result.ok ? ok({ deleted: true, id: goalId }) : err('deleting goal', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_goal_status_override',
    description: 'Manually override a goal\'s status (e.g. force "at_risk" or "achieved"), bypassing automatic progress-derived status. `id` accepts a UUID or the goal title.',
    input: {
      id: z.string().describe('Goal UUID or goal title'),
      status: z.enum(['draft', 'on_track', 'at_risk', 'behind', 'achieved', 'missed']).describe('New status to set'),
    },
    returns: goalShape,
    handler: async ({ id, status }) => {
      const goalId = await resolveGoalId(client, id);
      if (!goalId) {
        return err('overriding goal status', { message: `Goal not found by title or id: ${id}` });
      }
      const result = await client.request('POST', `/goals/${goalId}/status`, { status });
      return result.ok ? ok(result.data) : err('overriding goal status', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_goal_updates',
    description: 'List the status updates posted on a goal. `id` accepts a UUID or the goal title.',
    input: {
      id: z.string().describe('Goal UUID or goal title'),
    },
    returns: z.object({ data: z.array(z.object({ id: z.string().uuid(), goal_id: z.string().uuid(), status: z.string(), body: z.string().nullable().optional(), created_at: z.string() }).passthrough()) }),
    handler: async ({ id }) => {
      const goalId = await resolveGoalId(client, id);
      if (!goalId) {
        return err('listing goal updates', { message: `Goal not found by title or id: ${id}` });
      }
      const result = await client.request('GET', `/goals/${goalId}/updates`);
      return result.ok ? ok(result.data) : err('listing goal updates', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_goal_watchers',
    description: 'List the users watching a goal. `id` accepts a UUID or the goal title.',
    input: {
      id: z.string().describe('Goal UUID or goal title'),
    },
    returns: z.object({ data: z.array(z.object({ user_id: z.string().uuid() }).passthrough()) }),
    handler: async ({ id }) => {
      const goalId = await resolveGoalId(client, id);
      if (!goalId) {
        return err('listing goal watchers', { message: `Goal not found by title or id: ${id}` });
      }
      const result = await client.request('GET', `/goals/${goalId}/watchers`);
      return result.ok ? ok(result.data) : err('listing goal watchers', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_goal_watch',
    description: 'Add the calling user as a watcher on a goal (subscribe to its updates). `id` accepts a UUID or the goal title. The watcher is always the authenticated caller; there is no target-user parameter.',
    input: {
      id: z.string().describe('Goal UUID or goal title'),
    },
    returns: z.object({ goal_id: z.string().uuid(), user_id: z.string().uuid() }).passthrough(),
    handler: async ({ id }) => {
      const goalId = await resolveGoalId(client, id);
      if (!goalId) {
        return err('adding goal watcher', { message: `Goal not found by title or id: ${id}` });
      }
      const result = await client.request('POST', `/goals/${goalId}/watchers`);
      return result.ok ? ok(result.data) : err('adding goal watcher', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_goal_unwatch',
    description: 'Remove a watcher from a goal. `id` accepts a UUID or goal title; `user_id` accepts a UUID or email address. You may remove yourself, or — if you are the goal owner or an org admin/owner — remove another user.',
    input: {
      id: z.string().describe('Goal UUID or goal title'),
      user_id: z.string().describe('Watcher to remove: user UUID or email address'),
    },
    returns: z.object({ removed: z.literal(true), goal_id: z.string().uuid(), user_id: z.string().uuid() }),
    handler: async ({ id, user_id }) => {
      const goalId = await resolveGoalId(client, id);
      if (!goalId) {
        return err('removing goal watcher', { message: `Goal not found by title or id: ${id}` });
      }
      const userId = await resolveOwnerId(api, user_id);
      if (!userId) {
        return err('removing goal watcher', { message: `User not found by email or id: ${user_id}` });
      }
      const result = await client.request('DELETE', `/goals/${goalId}/watchers/${userId}`);
      return result.ok ? ok({ removed: true, goal_id: goalId, user_id: userId }) : err('removing goal watcher', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_goal_history',
    description: 'Get the progress history (point-in-time snapshots) for a goal. `id` accepts a UUID or the goal title.',
    input: {
      id: z.string().describe('Goal UUID or goal title'),
    },
    returns: z.object({ data: z.array(z.object({}).passthrough()) }).passthrough(),
    handler: async ({ id }) => {
      const goalId = await resolveGoalId(client, id);
      if (!goalId) {
        return err('fetching goal history', { message: `Goal not found by title or id: ${id}` });
      }
      const result = await client.request('GET', `/goals/${goalId}/history`);
      return result.ok ? ok(result.data) : err('fetching goal history', result.data);
    },
  });

  // ===== KEY RESULTS — additional (list / get / delete / links / history) =====

  registerTool(server, {
    name: 'bearing_kr_list',
    description: 'List the key results for a goal. `goal_id` accepts a UUID or the goal title.',
    input: {
      goal_id: z.string().describe('Goal UUID or goal title'),
    },
    returns: z.object({ data: z.array(krShape) }),
    handler: async ({ goal_id }) => {
      const goalId = await resolveGoalId(client, goal_id);
      if (!goalId) {
        return err('listing key results', { message: `Goal not found by title or id: ${goal_id}` });
      }
      const result = await client.request('GET', `/goals/${goalId}/key-results`);
      return result.ok ? ok(result.data) : err('listing key results', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_kr_get',
    description: 'Get a single key result. `id` accepts a UUID or the KR title — if the title is shared across multiple goals the tool fails and asks for disambiguation.',
    input: {
      id: z.string().describe('Key result UUID or KR title'),
    },
    returns: krShape,
    handler: async ({ id }) => {
      const krId = await resolveKeyResultId(client, id);
      if (!krId) {
        return err('getting key result', {
          message: `Key result not found by title or id: ${id}. If the title is shared across multiple goals, pass the UUID.`,
        });
      }
      const result = await client.request('GET', `/key-results/${krId}`);
      return result.ok ? ok(result.data) : err('getting key result', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_kr_delete',
    description: 'Delete a key result. `id` accepts a UUID or the KR title — if the title is shared across multiple goals the tool fails and asks for disambiguation.',
    input: {
      id: z.string().describe('Key result UUID or KR title'),
    },
    returns: z.object({ deleted: z.literal(true), id: z.string().uuid() }),
    handler: async ({ id }) => {
      const krId = await resolveKeyResultId(client, id);
      if (!krId) {
        return err('deleting key result', {
          message: `Key result not found by title or id: ${id}. If the title is shared across multiple goals, pass the UUID.`,
        });
      }
      const result = await client.request('DELETE', `/key-results/${krId}`);
      return result.ok ? ok({ deleted: true, id: krId }) : err('deleting key result', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_kr_links',
    description: 'List the Bam-entity links attached to a key result. `key_result_id` accepts a UUID or the KR title.',
    input: {
      key_result_id: z.string().describe('Key result UUID or KR title'),
    },
    returns: z.object({ data: z.array(z.object({ id: z.string().uuid(), key_result_id: z.string().uuid() }).passthrough()) }),
    handler: async ({ key_result_id }) => {
      const krId = await resolveKeyResultId(client, key_result_id);
      if (!krId) {
        return err('listing key result links', {
          message: `Key result not found by title or id: ${key_result_id}. If the title is shared across multiple goals, pass the UUID.`,
        });
      }
      const result = await client.request('GET', `/key-results/${krId}/links`);
      return result.ok ? ok(result.data) : err('listing key result links', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_kr_unlink',
    description: 'Remove a link from a key result. `key_result_id` accepts a UUID or the KR title; `link_id` is the link UUID (get it from bearing_kr_links).',
    input: {
      key_result_id: z.string().describe('Key result UUID or KR title'),
      link_id: z.string().uuid().describe('Link UUID to remove'),
    },
    returns: z.object({ removed: z.literal(true), key_result_id: z.string().uuid(), link_id: z.string().uuid() }),
    handler: async ({ key_result_id, link_id }) => {
      const krId = await resolveKeyResultId(client, key_result_id);
      if (!krId) {
        return err('removing key result link', {
          message: `Key result not found by title or id: ${key_result_id}. If the title is shared across multiple goals, pass the UUID.`,
        });
      }
      const result = await client.request('DELETE', `/key-results/${krId}/links/${link_id}`);
      return result.ok
        ? ok({ removed: true, key_result_id: krId, link_id })
        : err('removing key result link', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_kr_history',
    description: 'Get the value/progress snapshot history for a key result. `id` accepts a UUID or the KR title.',
    input: {
      id: z.string().describe('Key result UUID or KR title'),
    },
    returns: z.object({ data: z.array(z.object({}).passthrough()) }).passthrough(),
    handler: async ({ id }) => {
      const krId = await resolveKeyResultId(client, id);
      if (!krId) {
        return err('fetching key result history', {
          message: `Key result not found by title or id: ${id}. If the title is shared across multiple goals, pass the UUID.`,
        });
      }
      const result = await client.request('GET', `/key-results/${krId}/history`);
      return result.ok ? ok(result.data) : err('fetching key result history', result.data);
    },
  });

  // ===== PERIODS — additional (create / update / delete / activate / complete) =====

  registerTool(server, {
    name: 'bearing_period_create',
    description: 'Create a new OKR period (planning window such as a quarter). Dates are YYYY-MM-DD.',
    input: {
      name: z.string().min(1).max(100).describe('Period label (e.g. "Q2 2026")'),
      period_type: z.enum(['quarter', 'half', 'year', 'month', 'custom']).describe('Period cadence'),
      starts_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Start date (YYYY-MM-DD)'),
      ends_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('End date (YYYY-MM-DD)'),
      status: z.enum(['planning', 'active', 'completed', 'archived']).optional().describe('Initial status (default planning)'),
    },
    returns: z.object({ id: z.string().uuid(), name: z.string(), status: z.string() }).passthrough(),
    handler: async (params) => {
      const result = await client.request('POST', '/periods', params);
      return result.ok ? ok(result.data) : err('creating period', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_period_update',
    description: 'Update an OKR period. `id` accepts a UUID or the period label (e.g. "Q2 2026"). Provide only the fields to change. Setting status to "archived" archives the period.',
    input: {
      id: z.string().describe('Period UUID or period label'),
      name: z.string().min(1).max(100).optional().describe('Updated label'),
      period_type: z.enum(['quarter', 'half', 'year', 'month', 'custom']).optional().describe('Updated cadence'),
      starts_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Updated start date (YYYY-MM-DD)'),
      ends_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('Updated end date (YYYY-MM-DD)'),
      status: z.enum(['planning', 'active', 'completed', 'archived']).optional().describe('Updated status'),
    },
    returns: z.object({ id: z.string().uuid(), name: z.string(), status: z.string() }).passthrough(),
    handler: async ({ id, ...rest }) => {
      const periodId = await resolvePeriodId(client, id);
      if (!periodId) {
        return err('updating period', { message: `Period not found by label or id: ${id}` });
      }
      const result = await client.request('PATCH', `/periods/${periodId}`, rest);
      return result.ok ? ok(result.data) : err('updating period', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_period_delete',
    description: 'Delete an OKR period. `id` accepts a UUID or the period label (e.g. "Q2 2026").',
    input: {
      id: z.string().describe('Period UUID or period label'),
    },
    returns: z.object({ deleted: z.literal(true), id: z.string().uuid() }),
    handler: async ({ id }) => {
      const periodId = await resolvePeriodId(client, id);
      if (!periodId) {
        return err('deleting period', { message: `Period not found by label or id: ${id}` });
      }
      const result = await client.request('DELETE', `/periods/${periodId}`);
      return result.ok ? ok({ deleted: true, id: periodId }) : err('deleting period', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_period_activate',
    description: 'Activate an OKR period (mark it the current/live planning window). `id` accepts a UUID or the period label.',
    input: {
      id: z.string().describe('Period UUID or period label'),
    },
    returns: z.object({ id: z.string().uuid(), name: z.string(), status: z.string() }).passthrough(),
    handler: async ({ id }) => {
      const periodId = await resolvePeriodId(client, id);
      if (!periodId) {
        return err('activating period', { message: `Period not found by label or id: ${id}` });
      }
      const result = await client.request('POST', `/periods/${periodId}/activate`);
      return result.ok ? ok(result.data) : err('activating period', result.data);
    },
  });

  registerTool(server, {
    name: 'bearing_period_complete',
    description: 'Complete an OKR period (close it out at end of cadence). `id` accepts a UUID or the period label.',
    input: {
      id: z.string().describe('Period UUID or period label'),
    },
    returns: z.object({ id: z.string().uuid(), name: z.string(), status: z.string() }).passthrough(),
    handler: async ({ id }) => {
      const periodId = await resolvePeriodId(client, id);
      if (!periodId) {
        return err('completing period', { message: `Period not found by label or id: ${id}` });
      }
      const result = await client.request('POST', `/periods/${periodId}/complete`);
      return result.ok ? ok(result.data) : err('completing period', result.data);
    },
  });
}
