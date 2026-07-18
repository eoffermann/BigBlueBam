import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { registerTool } from '../lib/register-tool.js';

/**
 * Cross-app unified search MCP tool (AGENTIC_TODO §2, Wave 3).
 *
 * Fans out to every per-app search endpoint in parallel using
 * Promise.allSettled plus per-arm AbortController timeouts, normalizes each
 * app's native ranking into a comparable 0..1 score, applies a per-app
 * weight, and returns a unified hit list.
 *
 * A hard "one request per source app" rule is a useful simplification for
 * every arm except Bam tasks. Bam task search is project-scoped, so the
 * Bam arm internally fans out across the caller's visible projects with an
 * inner Promise.all. That inner fan-out is still enclosed in a single arm
 * from the outer Promise.allSettled point of view, so a single pathological
 * project does not fail the whole arm (it just drops that project's hits).
 *
 * Visibility preflight is opt-in via as_user_id. Without it, the caller
 * sees what the caller's own token can see (standard per-app auth). With
 * it, we run POST /v1/visibility/can_access for every hit in the canonical
 * allowlist and filter out denied entities. Banter messages and Board
 * elements are NOT in the Wave 2 can_access allowlist, so they are always
 * included based on the app's own RLS (banter channel membership, board
 * visibility). This is documented in the tool description so callers can
 * decide whether to surface those hits.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EntityType =
  | 'task'
  | 'ticket'
  | 'deal'
  | 'contact'
  | 'company'
  | 'document'
  | 'beacon'
  | 'message'
  | 'board'
  | 'metric';

type SourceApp =
  | 'bam'
  | 'helpdesk'
  | 'bond'
  | 'brief'
  | 'beacon'
  | 'banter'
  | 'board'
  | 'basis';

interface Hit {
  entity_type: EntityType;
  entity_id: string;
  title: string;
  snippet: string;
  score: number;
  source_app: SourceApp;
  url: string;
}

interface ArmResult {
  hits: Array<{
    entity_type: EntityType;
    entity_id: string;
    title: string;
    snippet: string;
    local_score?: number;
    source_app: SourceApp;
    url: string;
  }>;
}

interface ArmError {
  source_app: SourceApp;
  message: string;
}

/** URL builders for each entity type. Centralized so tests can assert. */
const URL_BUILDERS: Record<EntityType, (id: string) => string> = {
  task: (id) => `/b3/tasks/${id}`,
  ticket: (id) => `/helpdesk/tickets/${id}`,
  deal: (id) => `/bond/deals/${id}`,
  contact: (id) => `/bond/contacts/${id}`,
  company: (id) => `/bond/companies/${id}`,
  document: (id) => `/brief/documents/${id}`,
  beacon: (id) => `/beacon/${id}`,
  message: (id) => `/banter/messages/${id}`,
  board: (id) => `/board/boards/${id}`,
  metric: (id) => `/basis/metrics/${id}`,
};

/** Per-app weights applied after normalization. */
const APP_WEIGHTS: Record<EntityType, number> = {
  beacon: 1.2,
  task: 1.0,
  ticket: 1.0,
  deal: 1.0,
  contact: 1.0,
  company: 1.0,
  document: 0.9,
  board: 0.9,
  message: 0.7,
  metric: 1.1,
};

/**
 * Canonical entity_type values for the can_access endpoint (Wave 2 §11).
 * Undefined for types that are not in the allowlist; those hits are never
 * gated by can_access and rely on the source app's own RLS.
 */
const CAN_ACCESS_TYPE: Partial<Record<EntityType, string>> = {
  task: 'bam.task',
  ticket: 'helpdesk.ticket',
  deal: 'bond.deal',
  contact: 'bond.contact',
  company: 'bond.company',
  document: 'brief.document',
  beacon: 'beacon.entry',
  // message: not in the Wave 2 allowlist
  // board:   not in the Wave 2 allowlist
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateSnippet(s: string | undefined | null, max = 240): string {
  if (!s) return '';
  const trimmed = String(s).trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

/**
 * Fetch with an AbortController timeout. On timeout we throw a descriptive
 * error so Promise.allSettled captures it and the outer tool reports the
 * arm in `errors[]` rather than silently dropping it.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    const aborted = (err as { name?: string })?.name === 'AbortError';
    throw new Error(aborted ? `timed out after ${timeoutMs}ms` : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the bearer token from the ApiClient used by other tools. */
function bearerToken(api: ApiClient): string | undefined {
  return (api as unknown as { token?: string }).token;
}

function authHeaders(api: ApiClient): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = bearerToken(api);
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

// ---------------------------------------------------------------------------
// Arm implementations
// Each returns ArmResult on success, or throws so the outer allSettled
// captures the failure and surfaces it in `errors[]`.
// ---------------------------------------------------------------------------

/**
 * Bam tasks arm. Fans out across the caller's visible projects because
 * the task list endpoint is project-scoped. Failures inside the inner
 * fan-out are swallowed to avoid losing the whole arm over one slow
 * project; the outer timeout still applies and caps total wall time.
 */
async function searchBamTasks(
  apiBaseUrl: string,
  api: ApiClient,
  query: string,
  limit: number,
  timeoutMs: number,
): Promise<ArmResult> {
  const base = apiBaseUrl.replace(/\/$/, '');
  const headers = authHeaders(api);

  const projectsRes = await fetchWithTimeout(
    `${base}/projects?limit=50`,
    { method: 'GET', headers },
    timeoutMs,
  );
  if (!projectsRes.ok) {
    throw new Error(`listing projects failed: status ${projectsRes.status}`);
  }
  const projects =
    ((projectsRes.data as { data?: Array<{ id: string }> } | null)?.data) ?? [];

  // Per-project task search, in parallel. Use Math.min on limit since a
  // single very-active project could otherwise exhaust the arm budget.
  const perProjectLimit = Math.max(1, Math.min(limit, 25));
  const perProjectResults = await Promise.all(
    projects.map(async (p) => {
      try {
        const qs = new URLSearchParams({
          search: query,
          limit: String(perProjectLimit),
        });
        const r = await fetchWithTimeout(
          `${base}/projects/${p.id}/tasks?${qs.toString()}`,
          { method: 'GET', headers },
          timeoutMs,
        );
        if (!r.ok) return [];
        const tasks =
          ((r.data as { data?: Array<Record<string, unknown>> } | null)?.data) ??
          [];
        return tasks.map((t, idx) => ({
          entity_type: 'task' as const,
          entity_id: String(t.id ?? ''),
          title: String(t.title ?? t.human_id ?? '(untitled task)'),
          snippet: truncateSnippet(
            (t.description as string | undefined) ??
              (t.human_id as string | undefined) ??
              '',
          ),
          // Bam tasks don't carry a relevance score; fall back to
          // descending rank within the arm.
          local_score: Math.max(0, 1 - idx / Math.max(1, tasks.length)),
          source_app: 'bam' as const,
          url: URL_BUILDERS.task(String(t.id ?? '')),
        }));
      } catch {
        return [];
      }
    }),
  );

  const hits = perProjectResults.flat();
  return { hits };
}

async function searchHelpdeskTickets(
  helpdeskApiUrl: string,
  api: ApiClient,
  query: string,
  timeoutMs: number,
): Promise<ArmResult> {
  const base = helpdeskApiUrl.replace(/\/$/, '');
  const headers = authHeaders(api);
  const qs = new URLSearchParams({ q: query });
  const r = await fetchWithTimeout(
    `${base}/helpdesk/tickets/search?${qs.toString()}`,
    { method: 'GET', headers },
    timeoutMs,
  );
  if (!r.ok) throw new Error(`status ${r.status}`);
  const rows =
    ((r.data as { data?: Array<Record<string, unknown>> } | null)?.data) ?? [];
  return {
    hits: rows.map((t, idx) => ({
      entity_type: 'ticket' as const,
      entity_id: String(t.id ?? ''),
      title: String(t.subject ?? `Ticket #${t.number ?? ''}`),
      snippet: truncateSnippet(
        (t.body as string | undefined) ??
          (t.requester_email as string | undefined) ??
          '',
      ),
      // No score field on tickets; rank by position.
      local_score: Math.max(0, 1 - idx / Math.max(1, rows.length)),
      source_app: 'helpdesk' as const,
      url: URL_BUILDERS.ticket(String(t.id ?? '')),
    })),
  };
}

async function searchBondContacts(
  bondApiUrl: string,
  api: ApiClient,
  query: string,
  timeoutMs: number,
): Promise<ArmResult> {
  const base = bondApiUrl.replace(/\/$/, '');
  const headers = authHeaders(api);
  const qs = new URLSearchParams({ q: query });
  const r = await fetchWithTimeout(
    `${base}/contacts/search?${qs.toString()}`,
    { method: 'GET', headers },
    timeoutMs,
  );
  if (!r.ok) throw new Error(`status ${r.status}`);
  const rows =
    ((r.data as { data?: Array<Record<string, unknown>> } | null)?.data) ?? [];
  return {
    hits: rows.map((c, idx) => {
      const first = (c.first_name as string | undefined) ?? '';
      const last = (c.last_name as string | undefined) ?? '';
      const name = `${first} ${last}`.trim() || String(c.email ?? '(no name)');
      return {
        entity_type: 'contact' as const,
        entity_id: String(c.id ?? ''),
        title: name,
        snippet: truncateSnippet(
          (c.email as string | undefined) ??
            (c.phone as string | undefined) ??
            '',
        ),
        local_score: Math.max(0, 1 - idx / Math.max(1, rows.length)),
        source_app: 'bond' as const,
        url: URL_BUILDERS.contact(String(c.id ?? '')),
      };
    }),
  };
}

async function searchBondCompanies(
  bondApiUrl: string,
  api: ApiClient,
  query: string,
  timeoutMs: number,
): Promise<ArmResult> {
  const base = bondApiUrl.replace(/\/$/, '');
  const headers = authHeaders(api);
  const qs = new URLSearchParams({ q: query });
  const r = await fetchWithTimeout(
    `${base}/companies/search?${qs.toString()}`,
    { method: 'GET', headers },
    timeoutMs,
  );
  if (!r.ok) throw new Error(`status ${r.status}`);
  const rows =
    ((r.data as { data?: Array<Record<string, unknown>> } | null)?.data) ?? [];
  return {
    hits: rows.map((c, idx) => ({
      entity_type: 'company' as const,
      entity_id: String(c.id ?? ''),
      title: String(c.name ?? '(no name)'),
      snippet: truncateSnippet(
        (c.domain as string | undefined) ??
          (c.description as string | undefined) ??
          '',
      ),
      local_score: Math.max(0, 1 - idx / Math.max(1, rows.length)),
      source_app: 'bond' as const,
      url: URL_BUILDERS.company(String(c.id ?? '')),
    })),
  };
}

async function searchBriefDocuments(
  briefApiUrl: string,
  api: ApiClient,
  query: string,
  limit: number,
  timeoutMs: number,
): Promise<ArmResult> {
  const base = briefApiUrl.replace(/\/$/, '');
  const headers = authHeaders(api);
  const qs = new URLSearchParams({ query, limit: String(Math.min(limit, 100)) });
  const r = await fetchWithTimeout(
    `${base}/documents/search?${qs.toString()}`,
    { method: 'GET', headers },
    timeoutMs,
  );
  if (!r.ok) throw new Error(`status ${r.status}`);
  const rows =
    ((r.data as { data?: Array<Record<string, unknown>> } | null)?.data) ?? [];
  return {
    hits: rows.map((d, idx) => ({
      entity_type: 'document' as const,
      entity_id: String(d.id ?? ''),
      title: String(d.title ?? '(untitled document)'),
      snippet: truncateSnippet(
        (d.summary as string | undefined) ??
          (d.excerpt as string | undefined) ??
          '',
      ),
      local_score:
        typeof d.score === 'number'
          ? (d.score as number)
          : Math.max(0, 1 - idx / Math.max(1, rows.length)),
      source_app: 'brief' as const,
      url: URL_BUILDERS.document(String(d.id ?? '')),
    })),
  };
}

async function searchBeaconEntries(
  beaconApiUrl: string,
  api: ApiClient,
  query: string,
  limit: number,
  timeoutMs: number,
): Promise<ArmResult> {
  const base = beaconApiUrl.replace(/\/$/, '');
  const headers = authHeaders(api);
  const body = { query, options: { top_k: Math.min(limit, 100) } };
  const r = await fetchWithTimeout(
    `${base}/search`,
    { method: 'POST', headers, body: JSON.stringify(body) },
    timeoutMs,
  );
  if (!r.ok) throw new Error(`status ${r.status}`);
  // Beacon returns { results: [{beacon_id, title, summary, relevance_score, ...}] }
  const payload = (r.data as {
    results?: Array<Record<string, unknown>>;
    data?: Array<Record<string, unknown>>;
  } | null) ?? {};
  const rows = payload.results ?? payload.data ?? [];
  return {
    hits: rows.map((b, idx) => ({
      entity_type: 'beacon' as const,
      entity_id: String((b.beacon_id as string | undefined) ?? b.id ?? ''),
      title: String(b.title ?? '(untitled beacon)'),
      snippet: truncateSnippet(
        (b.summary as string | undefined) ??
          (b.highlight as string | undefined) ??
          '',
      ),
      local_score:
        typeof b.relevance_score === 'number'
          ? (b.relevance_score as number)
          : typeof b.score === 'number'
            ? (b.score as number)
            : Math.max(0, 1 - idx / Math.max(1, rows.length)),
      source_app: 'beacon' as const,
      url: URL_BUILDERS.beacon(
        String((b.beacon_id as string | undefined) ?? b.id ?? ''),
      ),
    })),
  };
}

async function searchBanterMessages(
  banterApiUrl: string,
  api: ApiClient,
  query: string,
  limit: number,
  timeoutMs: number,
): Promise<ArmResult> {
  const base = banterApiUrl.replace(/\/$/, '');
  const headers = authHeaders(api);
  const qs = new URLSearchParams({ q: query, limit: String(Math.min(limit, 50)) });
  const r = await fetchWithTimeout(
    `${base}/v1/search/messages?${qs.toString()}`,
    { method: 'GET', headers },
    timeoutMs,
  );
  if (!r.ok) throw new Error(`status ${r.status}`);
  const rows =
    ((r.data as { data?: Array<Record<string, unknown>> } | null)?.data) ?? [];
  return {
    hits: rows.map((m, idx) => ({
      entity_type: 'message' as const,
      entity_id: String(m.id ?? ''),
      title: String(
        (m.channel_name as string | undefined) ??
          (m.channel_id as string | undefined) ??
          '(banter message)',
      ),
      snippet: truncateSnippet((m.body as string | undefined) ?? ''),
      local_score: Math.max(0, 1 - idx / Math.max(1, rows.length)),
      source_app: 'banter' as const,
      url: URL_BUILDERS.message(String(m.id ?? '')),
    })),
  };
}

async function searchBoardElements(
  boardApiUrl: string,
  api: ApiClient,
  query: string,
  timeoutMs: number,
): Promise<ArmResult> {
  const base = boardApiUrl.replace(/\/$/, '');
  const headers = authHeaders(api);
  const qs = new URLSearchParams({ q: query });
  const r = await fetchWithTimeout(
    `${base}/boards/search?${qs.toString()}`,
    { method: 'GET', headers },
    timeoutMs,
  );
  if (!r.ok) throw new Error(`status ${r.status}`);
  const rows =
    ((r.data as { data?: Array<Record<string, unknown>> } | null)?.data) ?? [];
  return {
    hits: rows.map((row, idx) => {
      // boards/search returns flat rows: { board_id, board_name, element_id, text_content, element_type }
      const boardId = String(row.board_id ?? '');
      return {
        entity_type: 'board' as const,
        entity_id: boardId,
        title: String(row.board_name ?? '(untitled board)'),
        snippet: truncateSnippet(
          (row.text_content as string | undefined) ?? '',
        ),
        local_score: Math.max(0, 1 - idx / Math.max(1, rows.length)),
        source_app: 'board' as const,
        url: URL_BUILDERS.board(boardId),
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Normalization + scoring
// ---------------------------------------------------------------------------

/**
 * Normalize an arm's hits: divide each local_score by the arm's max score
 * so raw scores from different apps are comparable, then multiply by the
 * per-app weight. If every local_score is 0 (degenerate), everything gets
 * the weight directly so we still rank by app preference.
 */
function scoreHits(arm: ArmResult): Hit[] {
  if (arm.hits.length === 0) return [];
  const maxLocal = arm.hits.reduce(
    (m, h) => Math.max(m, h.local_score ?? 0),
    0,
  );
  return arm.hits.map((h) => {
    const local = h.local_score ?? 0;
    const normalized = maxLocal > 0 ? local / maxLocal : 1;
    const weight = APP_WEIGHTS[h.entity_type] ?? 1.0;
    return {
      entity_type: h.entity_type,
      entity_id: h.entity_id,
      title: h.title,
      snippet: h.snippet,
      score: Number((normalized * weight).toFixed(4)),
      source_app: h.source_app,
      url: h.url,
    };
  });
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

// Basis governed metrics. Basis has no server-side search param, so fetch the
// org's catalog (RLS-scoped by the caller's session) and match the query against
// name/slug client-side. Metrics are org-global (not per-user-restricted at the
// row level), so like banter/board hits they are included based on the source
// app's own org RLS rather than a can_access entity type.
async function searchBasisMetrics(
  basisApiUrl: string,
  api: ApiClient,
  query: string,
  timeoutMs: number,
): Promise<ArmResult> {
  const base = basisApiUrl.replace(/\/$/, '');
  const headers = authHeaders(api);
  const r = await fetchWithTimeout(
    `${base}/metrics?limit=200`,
    { method: 'GET', headers },
    timeoutMs,
  );
  if (!r.ok) throw new Error(`status ${r.status}`);
  const rows =
    ((r.data as { data?: Array<Record<string, unknown>> } | null)?.data) ?? [];
  const q = query.toLowerCase();
  const matched = rows.filter((m) => {
    const name = String(m.name ?? '').toLowerCase();
    const slug = String(m.slug ?? '').toLowerCase();
    return name.includes(q) || slug.includes(q);
  });
  return {
    hits: matched.map((m, idx) => {
      const cert = String(m.certification ?? 'draft');
      const unit = String(m.unit ?? '');
      return {
        entity_type: 'metric' as const,
        entity_id: String(m.id ?? ''),
        title: String(m.name ?? m.slug ?? '(unnamed metric)'),
        snippet: truncateSnippet(
          [`${cert} metric`, unit && `unit ${unit}`, m.slug && `slug ${m.slug}`]
            .filter(Boolean)
            .join(' - '),
        ),
        // Certified metrics rank above drafts within the arm.
        local_score:
          Math.max(0, 1 - idx / Math.max(1, matched.length)) *
          (cert === 'certified' ? 1 : cert === 'deprecated' ? 0.6 : 0.85),
        source_app: 'basis' as const,
        url: URL_BUILDERS.metric(String(m.id ?? '')),
      };
    }),
  };
}

const ENTITY_TYPES: readonly EntityType[] = [
  'task',
  'ticket',
  'deal',
  'contact',
  'company',
  'document',
  'beacon',
  'message',
  'board',
  'metric',
] as const;

/** Bundle of URLs so the tool can fan out to every app. */
export interface SearchToolUrls {
  apiUrl: string;
  helpdeskApiUrl: string;
  bondApiUrl: string;
  briefApiUrl: string;
  beaconApiUrl: string;
  banterApiUrl: string;
  boardApiUrl: string;
  basisApiUrl: string;
}

export function registerSearchTools(
  server: McpServer,
  api: ApiClient,
  urls: SearchToolUrls,
): void {
  registerTool(server, {
    name: 'search_everything',
    description:
      "Cross-app unified search. Fans out in parallel to per-app search endpoints (Bam tasks, Helpdesk tickets, Bond contacts/companies, Brief documents, Beacon entries, Banter messages, Board elements), normalizes each app's native relevance score, applies a per-app weight, and returns a ranked unified hit list. Use `types` to prune fan-out to a subset of entity kinds. Pass `as_user_id` to run a visibility preflight (can_access) on every supported hit and drop anything the asker cannot see; the count of dropped hits is reported as `filtered_count`. Note: Banter messages, Board elements, and Basis metrics are NOT in the Wave 2 can_access allowlist, so those hits are always included based on the source app's own RLS (banter channel membership, board visibility, and org-scoped metric catalog respectively). Each arm has a 3s timeout; arm-level failures are reported in `errors[]` without failing the whole call.",
    input: {
      query: z
        .string()
        .min(2)
        .max(500)
        .describe('Search phrase (2..500 chars)'),
      types: z
        .array(z.enum(ENTITY_TYPES as unknown as [EntityType, ...EntityType[]]))
        .optional()
        .describe(
          'Optional entity-type allowlist. If provided, only arms that serve those types are invoked.',
        ),
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe('Maximum number of unified results (default 50, max 200)'),
      as_user_id: z
        .string()
        .uuid()
        .optional()
        .describe(
          'Optional asker user id. When present, can_access gates every hit in the Wave 2 allowlist; hits the asker cannot see are dropped and counted in filtered_count.',
        ),
    },
    returns: z.object({
      data: z.array(
        z.object({
          entity_type: z.enum(
            ENTITY_TYPES as unknown as [EntityType, ...EntityType[]],
          ),
          entity_id: z.string(),
          title: z.string(),
          snippet: z.string(),
          score: z.number(),
          source_app: z.enum([
            'bam',
            'helpdesk',
            'bond',
            'brief',
            'beacon',
            'banter',
            'board',
            'basis',
          ]),
          url: z.string(),
        }),
      ),
      counts_by_type: z.record(z.number()),
      query_took_ms: z.number(),
      errors: z
        .array(z.object({ source_app: z.string(), message: z.string() }))
        .optional(),
      filtered_count: z.number().optional(),
    }),
    handler: async ({ query, types, limit, as_user_id }) => {
      const startedAt = Date.now();
      const capLimit = limit ?? 50;
      const wantedTypes = new Set<EntityType>(types ?? [...ENTITY_TYPES]);
      const TIMEOUT_MS = 3_000;

      interface NamedArm {
        source_app: SourceApp;
        fetch: () => Promise<ArmResult>;
      }

      const arms: NamedArm[] = [];
      if (wantedTypes.has('task')) {
        arms.push({
          source_app: 'bam',
          fetch: () =>
            searchBamTasks(urls.apiUrl, api, query, capLimit, TIMEOUT_MS),
        });
      }
      if (wantedTypes.has('ticket')) {
        arms.push({
          source_app: 'helpdesk',
          fetch: () =>
            searchHelpdeskTickets(urls.helpdeskApiUrl, api, query, TIMEOUT_MS),
        });
      }
      if (wantedTypes.has('contact')) {
        arms.push({
          source_app: 'bond',
          fetch: () =>
            searchBondContacts(urls.bondApiUrl, api, query, TIMEOUT_MS),
        });
      }
      if (wantedTypes.has('company')) {
        arms.push({
          source_app: 'bond',
          fetch: () =>
            searchBondCompanies(urls.bondApiUrl, api, query, TIMEOUT_MS),
        });
      }
      if (wantedTypes.has('document')) {
        arms.push({
          source_app: 'brief',
          fetch: () =>
            searchBriefDocuments(
              urls.briefApiUrl,
              api,
              query,
              capLimit,
              TIMEOUT_MS,
            ),
        });
      }
      if (wantedTypes.has('beacon')) {
        arms.push({
          source_app: 'beacon',
          fetch: () =>
            searchBeaconEntries(
              urls.beaconApiUrl,
              api,
              query,
              capLimit,
              TIMEOUT_MS,
            ),
        });
      }
      if (wantedTypes.has('message')) {
        arms.push({
          source_app: 'banter',
          fetch: () =>
            searchBanterMessages(
              urls.banterApiUrl,
              api,
              query,
              capLimit,
              TIMEOUT_MS,
            ),
        });
      }
      if (wantedTypes.has('board')) {
        arms.push({
          source_app: 'board',
          fetch: () =>
            searchBoardElements(urls.boardApiUrl, api, query, TIMEOUT_MS),
        });
      }
      if (wantedTypes.has('metric')) {
        arms.push({
          source_app: 'basis',
          fetch: () =>
            searchBasisMetrics(urls.basisApiUrl, api, query, TIMEOUT_MS),
        });
      }
      // `deal` is declared in the schema for forward-compat but there is no
      // /deals/search endpoint today. Pruning the arm keeps the tool honest
      // rather than silently returning empty for a type we don't serve.

      const settled = await Promise.allSettled(arms.map((a) => a.fetch()));

      const hits: Hit[] = [];
      const errors: ArmError[] = [];
      settled.forEach((res, idx) => {
        const armName = arms[idx]!.source_app;
        if (res.status === 'fulfilled') {
          hits.push(...scoreHits(res.value));
        } else {
          errors.push({
            source_app: armName,
            message:
              res.reason instanceof Error
                ? res.reason.message
                : String(res.reason),
          });
        }
      });

      // Visibility preflight when requested. Skip types not in the
      // can_access allowlist; they pass through unfiltered and the caller
      // can decide what to do with them based on the tool's documented
      // behavior.
      let filteredCount: number | undefined;
      let visibleHits = hits;
      if (as_user_id) {
        filteredCount = 0;
        const checks = await Promise.all(
          hits.map(async (h) => {
            const canonicalType = CAN_ACCESS_TYPE[h.entity_type];
            if (!canonicalType) return { hit: h, allowed: true };
            try {
              const res = await api.post<{
                data?: { allowed?: boolean };
              }>('/v1/visibility/can_access', {
                asker_user_id: as_user_id,
                entity_type: canonicalType,
                entity_id: h.entity_id,
              });
              if (!res.ok) {
                // A failed preflight is a denial by convention. See the
                // agent-conventions doc for the full policy.
                return { hit: h, allowed: false };
              }
              return {
                hit: h,
                allowed: res.data?.data?.allowed === true,
              };
            } catch {
              return { hit: h, allowed: false };
            }
          }),
        );
        visibleHits = [];
        for (const c of checks) {
          if (c.allowed) visibleHits.push(c.hit);
          else filteredCount += 1;
        }
      }

      // Sort and cap.
      visibleHits.sort((a, b) => b.score - a.score);
      const data = visibleHits.slice(0, capLimit);

      const counts_by_type: Record<string, number> = {};
      for (const h of data) {
        counts_by_type[h.entity_type] =
          (counts_by_type[h.entity_type] ?? 0) + 1;
      }

      const response: {
        data: Hit[];
        counts_by_type: Record<string, number>;
        query_took_ms: number;
        errors?: ArmError[];
        filtered_count?: number;
      } = {
        data,
        counts_by_type,
        query_took_ms: Date.now() - startedAt,
      };
      if (errors.length > 0) response.errors = errors;
      if (filteredCount !== undefined) response.filtered_count = filteredCount;

      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    },
  });
}

// Exported internals for unit tests. Not part of the public tool surface.
export const __testing = {
  URL_BUILDERS,
  APP_WEIGHTS,
  CAN_ACCESS_TYPE,
  scoreHits,
  truncateSnippet,
};
