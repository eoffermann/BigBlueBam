import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { extractPinnedMentions, stripPinnedMentions, type MentionKind } from '@bigbluebam/shared';
import type { ApiClient } from '../middleware/api-client.js';
import { registerTool } from '../lib/register-tool.js';
import { helpdeskAgentPath } from '../lib/helpdesk-agent-path.js';

/**
 * Fuzzy entity resolver (AGENTIC_TODO §3, Wave 3).
 *
 * Given free text, returns a ranked list of candidate entities with a
 * confidence score and (when siblings are close) a disambiguation hint.
 * No LLM. Pure two-phase pipeline:
 *
 *   1. Pinned mentions (via `@bigbluebam/shared` canonical patterns) are
 *      resolved through deterministic lookup endpoints. These score 1.0.
 *   2. The text with pinned spans stripped is broken into 2-6 word
 *      n-grams (capped at 5 phrases, longest-first) and each phrase is
 *      fanned out in parallel to every applicable app search endpoint.
 *      Top 3 results per app become candidates with a confidence derived
 *      from the API's relevance score dampened by how many siblings
 *      competed for the same phrase.
 *
 * Phase 3 attaches a disambiguation hint when 2+ candidates for the same
 * source_fragment score within 0.1 of each other.
 *
 * Entity type coverage (Wave 3): user, task, project, deal, contact,
 * company, ticket, document. Matches the can_access allowlist minus
 * sprints, beacons, banter messages, and boards; those will be folded in
 * once their visibility gates land.
 *
 * This tool is the canonical extract-then-resolve primitive. Clients
 * that need inline autocomplete should call resolve_references rather
 * than reimplementing per-app fan-out.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type EntityType =
  | 'user'
  | 'task'
  | 'project'
  | 'deal'
  | 'contact'
  | 'company'
  | 'ticket'
  | 'document';

interface Candidate {
  entity_type: EntityType;
  entity_id: string;
  label: string;
  confidence: number;
  disambiguation?: string;
  match_source: 'pinned' | 'search' | 'fuzzy';
  source_fragment: string;
}

interface ResolveResult {
  candidates: Candidate[];
  unresolved_fragments: string[];
}

// ---------------------------------------------------------------------------
// Cross-app HTTP helper
// ---------------------------------------------------------------------------

/**
 * Build a fetch helper that targets a sibling app's base URL while
 * forwarding the caller's bearer token, matching the pattern used across
 * bond-tools, beacon-tools, and brief-tools.
 */
function createAppClient(apiBaseUrl: string, api: ApiClient) {
  const baseUrl = apiBaseUrl.replace(/\/$/, '');
  return async function request<T = unknown>(
    method: string,
    path: string,
  ): Promise<{ ok: boolean; status: number; data: T }> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const token = (api as unknown as { token?: string }).token;
    if (token) headers['Authorization'] = `Bearer ${token}`;
    try {
      const res = await fetch(url, { method, headers });
      const data = (await res.json()) as T;
      return { ok: res.ok, status: res.status, data };
    } catch {
      return { ok: false, status: 0, data: {} as T };
    }
  };
}

// ---------------------------------------------------------------------------
// Phase 2 helpers: n-gram extraction
// ---------------------------------------------------------------------------

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'but',
  'by',
  'for',
  'from',
  'has',
  'have',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'was',
  'were',
  'will',
  'with',
  'other',
  'thing',
  'about',
]);

/**
 * Extract candidate phrases from free text for Phase 2 fuzzy search.
 *
 * Steps:
 *   1. Tokenize on whitespace and punctuation. Drop stopwords.
 *   2. Build 2-word, 3-word, ..., up to 6-word contiguous n-grams.
 *   3. Keep only phrases whose first and last tokens are non-stopwords
 *      (so "the Acme deal" surfaces "Acme deal", not "the Acme").
 *   4. Sort by length descending, then cap at 5.
 *
 * Cap of 5 phrases keeps the parallel fan-out bounded: 5 phrases * 6
 * apps * ~3 results each = ~90 candidates upper bound before ranking.
 */
export function extractNgramPhrases(text: string): string[] {
  const cleaned = text
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return [];

  const tokens = cleaned.split(' ').filter((t) => t.length > 0);
  if (tokens.length === 0) return [];

  const phrases: string[] = [];
  const seen = new Set<string>();
  for (let n = 2; n <= 6; n += 1) {
    for (let i = 0; i + n <= tokens.length; i += 1) {
      const window = tokens.slice(i, i + n);
      const first = window[0]!.toLowerCase();
      const last = window[window.length - 1]!.toLowerCase();
      if (STOPWORDS.has(first) || STOPWORDS.has(last)) continue;
      const phrase = window.join(' ');
      const key = phrase.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      phrases.push(phrase);
    }
  }

  phrases.sort((a, b) => {
    const aLen = a.split(' ').length;
    const bLen = b.split(' ').length;
    if (aLen !== bLen) return bLen - aLen;
    return a.localeCompare(b);
  });
  return phrases.slice(0, 5);
}

// ---------------------------------------------------------------------------
// Phase 1: pinned mention resolution
// ---------------------------------------------------------------------------

interface AppUrls {
  bondApiUrl: string;
  briefApiUrl: string;
  helpdeskApiUrl: string;
}

/**
 * Resolve every pinned mention in `text` to a concrete candidate.
 * Callers share the same ApiClient + sibling app URLs; every lookup is
 * paralleled via Promise.all.
 */
async function resolvePinnedMentions(
  text: string,
  api: ApiClient,
  urls: AppUrls,
): Promise<Candidate[]> {
  const mentions = extractPinnedMentions(text);
  if (mentions.length === 0) return [];

  const bond = createAppClient(urls.bondApiUrl, api);
  const brief = createAppClient(urls.briefApiUrl, api);
  const helpdesk = createAppClient(urls.helpdeskApiUrl, api);

  const jobs = mentions.map(async (m): Promise<Candidate | null> => {
    try {
      return await resolveOnePinnedMention(m, api, bond, brief, helpdesk);
    } catch {
      return null;
    }
  });
  const results = await Promise.all(jobs);
  return results.filter((c): c is Candidate => c !== null);
}

/**
 * Route a single pinned mention to the right lookup endpoint. Each branch
 * returns `null` when the lookup does not find a match so the caller can
 * carry the unresolved fragment forward into `unresolved_fragments`.
 */
async function resolveOnePinnedMention(
  m: { kind: MentionKind; value: string; fragment: string },
  api: ApiClient,
  bond: (method: string, path: string) => Promise<{ ok: boolean; data: unknown }>,
  brief: (method: string, path: string) => Promise<{ ok: boolean; data: unknown }>,
  helpdesk: (method: string, path: string) => Promise<{ ok: boolean; data: unknown }>,
): Promise<Candidate | null> {
  const pinned = {
    match_source: 'pinned' as const,
    confidence: 1.0,
    source_fragment: m.fragment,
  };

  switch (m.kind) {
    case 'task': {
      const res = await api.get<{ id?: string; title?: string; human_id?: string }>(
        `/tasks/by-ref/${encodeURIComponent(m.value)}`,
      );
      if (!res.ok) return null;
      const data = (res.data ?? {}) as { id?: string; title?: string; human_id?: string };
      if (!data.id) return null;
      return {
        entity_type: 'task',
        entity_id: data.id,
        label: data.title ? `${data.human_id ?? m.value}: ${data.title}` : (data.human_id ?? m.value),
        ...pinned,
      };
    }
    case 'deal': {
      const res = await bond('GET', `/deals?search=${encodeURIComponent(m.value)}&limit=3`);
      if (!res.ok) return null;
      const rows = extractRows(res.data) as Array<{ id?: string; name?: string }>;
      const exact = rows.find((r) => (r.name ?? '').toLowerCase() === m.value.toLowerCase());
      const pick = exact ?? rows[0];
      if (!pick?.id) return null;
      return {
        entity_type: 'deal',
        entity_id: pick.id,
        label: pick.name ?? m.value,
        ...pinned,
      };
    }
    case 'contact': {
      // Email-first: if the pin looks like an email, try /users/by-email
      // on the Bam API (shared users table) and bond /contacts/search as
      // a parallel fallback. Otherwise jump straight to contacts/search.
      const looksLikeEmail = /@/.test(m.value);
      if (looksLikeEmail) {
        const res = await bond('GET', `/contacts/search?q=${encodeURIComponent(m.value)}&limit=3`);
        if (res.ok) {
          const rows = extractRows(res.data) as Array<{ id?: string; name?: string; email?: string }>;
          const pick = rows.find(
            (r) => (r.email ?? '').toLowerCase() === m.value.toLowerCase(),
          ) ?? rows[0];
          if (pick?.id) {
            return {
              entity_type: 'contact',
              entity_id: pick.id,
              label: pick.email ?? pick.name ?? m.value,
              ...pinned,
            };
          }
        }
        return null;
      }
      const res = await bond('GET', `/contacts/search?q=${encodeURIComponent(m.value)}&limit=3`);
      if (!res.ok) return null;
      const rows = extractRows(res.data) as Array<{ id?: string; name?: string }>;
      const pick = rows[0];
      if (!pick?.id) return null;
      return {
        entity_type: 'contact',
        entity_id: pick.id,
        label: pick.name ?? m.value,
        ...pinned,
      };
    }
    case 'company': {
      const res = await bond('GET', `/companies/search?q=${encodeURIComponent(m.value)}&limit=3`);
      if (!res.ok) return null;
      const rows = extractRows(res.data) as Array<{ id?: string; name?: string }>;
      const exact = rows.find((r) => (r.name ?? '').toLowerCase() === m.value.toLowerCase());
      const pick = exact ?? rows[0];
      if (!pick?.id) return null;
      return {
        entity_type: 'company',
        entity_id: pick.id,
        label: pick.name ?? m.value,
        ...pinned,
      };
    }
    case 'document': {
      // Prefer the dedicated by-slug route; fall back to search on miss.
      const bySlug = await brief('GET', `/documents/by-slug/${encodeURIComponent(m.value)}`);
      if (bySlug.ok) {
        const data = (bySlug.data as { data?: { id?: string; title?: string } } | null)?.data;
        if (data?.id) {
          return {
            entity_type: 'document',
            entity_id: data.id,
            label: data.title ?? m.value,
            ...pinned,
          };
        }
      }
      const search = await brief('GET', `/documents/search?query=${encodeURIComponent(m.value)}`);
      if (!search.ok) return null;
      const rows = extractRows(search.data) as Array<{ id?: string; title?: string; slug?: string }>;
      const pick = rows.find((r) => r.slug === m.value) ?? rows[0];
      if (!pick?.id) return null;
      return {
        entity_type: 'document',
        entity_id: pick.id,
        label: pick.title ?? m.value,
        ...pinned,
      };
    }
    case 'ticket': {
      const stripped = m.value.replace(/^#/, '');
      const res = await helpdesk('GET', helpdeskAgentPath(`/tickets/by-number/${encodeURIComponent(stripped)}`));
      if (!res.ok) return null;
      const data = (res.data as { data?: { id?: string; subject?: string; ticket_number?: number } } | null)?.data;
      if (!data?.id) return null;
      return {
        entity_type: 'ticket',
        entity_id: data.id,
        label: data.subject ? `#${data.ticket_number ?? stripped}: ${data.subject}` : `#${stripped}`,
        ...pinned,
      };
    }
    case 'user': {
      // Handle-as-email first: if the value contains '@' treat the whole
      // thing as an email and hit /users/by-email directly. Otherwise
      // fall back to /users/search and prefer an exact local-part match
      // so @jane.doe resolves to jane.doe@* over janedoe2@*.
      if (m.value.includes('@')) {
        const res = await api.get<{ data?: { id?: string; email?: string; display_name?: string } }>(
          `/users/by-email?email=${encodeURIComponent(m.value)}`,
        );
        if (res.ok) {
          const data = res.data?.data;
          if (data?.id) {
            return {
              entity_type: 'user',
              entity_id: data.id,
              label: data.display_name ?? data.email ?? m.value,
              ...pinned,
            };
          }
        }
        return null;
      }
      const search = await api.get<{ data?: Array<{ id?: string; email?: string; display_name?: string }> }>(
        `/users/search?q=${encodeURIComponent(m.value)}`,
      );
      if (!search.ok) return null;
      const rows = search.data?.data ?? [];
      const exact = rows.find(
        (r) => (r.email ?? '').split('@')[0]?.toLowerCase() === m.value.toLowerCase(),
      );
      const pick = exact ?? rows[0];
      if (!pick?.id) return null;
      return {
        entity_type: 'user',
        entity_id: pick.id,
        label: pick.display_name ?? pick.email ?? m.value,
        ...pinned,
      };
    }
    case 'project': {
      // No by-slug route exists; list visible projects and match slug.
      const res = await api.get<{ data?: Array<{ id?: string; slug?: string; name?: string }> }>(
        '/projects?limit=200',
      );
      if (!res.ok) return null;
      const rows = res.data?.data ?? [];
      const pick = rows.find((r) => (r.slug ?? '').toLowerCase() === m.value.toLowerCase());
      if (!pick?.id) return null;
      return {
        entity_type: 'project',
        entity_id: pick.id,
        label: pick.name ?? m.value,
        ...pinned,
      };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Phase 2: natural-language fan-out
// ---------------------------------------------------------------------------

/** Shape of a single hit that has been normalized out of a search response. */
interface RawHit {
  entity_type: EntityType;
  entity_id: string;
  label: string;
  score: number;
  extra?: Record<string, unknown>;
}

/**
 * Run a phrase through every applicable search endpoint in parallel,
 * capping each app's contribution at 3 hits. Returns candidates with
 * confidence = normalized_score * (1 / (1 + sibling_count)).
 */
async function resolvePhraseCandidates(
  phrase: string,
  api: ApiClient,
  urls: AppUrls,
): Promise<Candidate[]> {
  const bond = createAppClient(urls.bondApiUrl, api);
  const brief = createAppClient(urls.briefApiUrl, api);
  const helpdesk = createAppClient(urls.helpdeskApiUrl, api);

  const encoded = encodeURIComponent(phrase);
  const tasks: Promise<RawHit[]>[] = [
    // Bam tasks: /tasks?q=... returns { data: [...] }. We do not know
    // project_id at this level; Bam's top-level /tasks route is the
    // org-wide search surface. Fall back gracefully if it 404s.
    (async () => {
      const res = await api.get<{ data?: Array<{ id?: string; title?: string; human_id?: string }> }>(
        `/tasks/search?q=${encoded}&limit=3`,
      );
      if (!res.ok) return [];
      const rows = res.data?.data ?? [];
      return rows.slice(0, 3).map<RawHit>((r, idx) => ({
        entity_type: 'task',
        entity_id: r.id ?? '',
        label: r.title ? `${r.human_id ?? ''} ${r.title}`.trim() : (r.human_id ?? ''),
        score: 1 - idx * 0.15,
      })).filter((h) => h.entity_id);
    })(),
    // Bam projects
    (async () => {
      const res = await api.get<{ data?: Array<{ id?: string; name?: string }> }>(
        '/projects?limit=200',
      );
      if (!res.ok) return [];
      const rows = res.data?.data ?? [];
      const needle = phrase.toLowerCase();
      const filtered = rows
        .filter((r) => (r.name ?? '').toLowerCase().includes(needle))
        .slice(0, 3);
      return filtered.map<RawHit>((r, idx) => ({
        entity_type: 'project',
        entity_id: r.id ?? '',
        label: r.name ?? '',
        score: 1 - idx * 0.15,
      })).filter((h) => h.entity_id);
    })(),
    // Users
    (async () => {
      const res = await api.get<{ data?: Array<{ id?: string; display_name?: string; email?: string }> }>(
        `/users/search?q=${encoded}`,
      );
      if (!res.ok) return [];
      const rows = res.data?.data ?? [];
      return rows.slice(0, 3).map<RawHit>((r, idx) => ({
        entity_type: 'user',
        entity_id: r.id ?? '',
        label: r.display_name ?? r.email ?? '',
        score: 1 - idx * 0.15,
        extra: { email: r.email },
      })).filter((h) => h.entity_id);
    })(),
    // Bond deals
    (async () => {
      const res = await bond('GET', `/deals?search=${encoded}&limit=3`);
      if (!res.ok) return [];
      const rows = extractRows(res.data) as Array<{
        id?: string;
        name?: string;
        stage_name?: string;
        pipeline_id?: string;
        stage_id?: string;
      }>;
      return rows.slice(0, 3).map<RawHit>((r, idx) => ({
        entity_type: 'deal',
        entity_id: r.id ?? '',
        label: r.name ?? '',
        score: 1 - idx * 0.15,
        extra: { stage_name: r.stage_name, pipeline_id: r.pipeline_id, stage_id: r.stage_id },
      })).filter((h) => h.entity_id);
    })(),
    // Bond contacts
    (async () => {
      const res = await bond('GET', `/contacts/search?q=${encoded}&limit=3`);
      if (!res.ok) return [];
      const rows = extractRows(res.data) as Array<{ id?: string; name?: string; email?: string }>;
      return rows.slice(0, 3).map<RawHit>((r, idx) => ({
        entity_type: 'contact',
        entity_id: r.id ?? '',
        label: r.name ?? r.email ?? '',
        score: 1 - idx * 0.15,
        extra: { email: r.email },
      })).filter((h) => h.entity_id);
    })(),
    // Bond companies
    (async () => {
      const res = await bond('GET', `/companies/search?q=${encoded}&limit=3`);
      if (!res.ok) return [];
      const rows = extractRows(res.data) as Array<{
        id?: string;
        name?: string;
        owner_id?: string;
        owner_name?: string;
      }>;
      return rows.slice(0, 3).map<RawHit>((r, idx) => ({
        entity_type: 'company',
        entity_id: r.id ?? '',
        label: r.name ?? '',
        score: 1 - idx * 0.15,
        extra: { owner_id: r.owner_id, owner_name: r.owner_name },
      })).filter((h) => h.entity_id);
    })(),
    // Helpdesk tickets
    (async () => {
      const res = await helpdesk('GET', helpdeskAgentPath(`/tickets/search?q=${encoded}`));
      if (!res.ok) return [];
      const rows = extractRows(res.data) as Array<{
        id?: string;
        subject?: string;
        number?: number;
      }>;
      return rows.slice(0, 3).map<RawHit>((r, idx) => ({
        entity_type: 'ticket',
        entity_id: r.id ?? '',
        label: r.subject ? `#${r.number ?? ''}: ${r.subject}` : `#${r.number ?? ''}`,
        score: 1 - idx * 0.15,
      })).filter((h) => h.entity_id);
    })(),
    // Brief documents
    (async () => {
      const res = await brief('GET', `/documents/search?query=${encoded}`);
      if (!res.ok) return [];
      const rows = extractRows(res.data) as Array<{ id?: string; title?: string }>;
      return rows.slice(0, 3).map<RawHit>((r, idx) => ({
        entity_type: 'document',
        entity_id: r.id ?? '',
        label: r.title ?? '',
        score: 1 - idx * 0.15,
      })).filter((h) => h.entity_id);
    })(),
  ];

  const settled = await Promise.allSettled(tasks);
  const hits: RawHit[] = [];
  for (const s of settled) {
    if (s.status === 'fulfilled') hits.push(...s.value);
  }

  const siblingCount = hits.length;
  const dampener = 1 / (1 + siblingCount);

  const candidates = hits.map<Candidate>((h) => {
    const base: Candidate = {
      entity_type: h.entity_type,
      entity_id: h.entity_id,
      label: h.label,
      confidence: clamp01(h.score * dampener),
      match_source: 'search',
      source_fragment: phrase,
    };
    const hint = buildDisambiguationHint(h);
    if (hint) base.disambiguation = hint;
    return base;
  });

  return candidates;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function buildDisambiguationHint(h: RawHit): string | undefined {
  const extra = h.extra ?? {};
  if (h.entity_type === 'contact' && typeof extra.email === 'string' && extra.email) {
    return emailFragment(extra.email);
  }
  if (h.entity_type === 'deal' && typeof extra.stage_name === 'string' && extra.stage_name) {
    return `stage: ${extra.stage_name}`;
  }
  if (h.entity_type === 'company' && typeof extra.owner_name === 'string' && extra.owner_name) {
    return `owner: ${extra.owner_name}`;
  }
  if (h.entity_type === 'user' && typeof extra.email === 'string' && extra.email) {
    return emailFragment(extra.email);
  }
  return undefined;
}

function emailFragment(email: string): string {
  // Show the first character of the local part plus the full domain so
  // two "Jane"s at different companies are distinguishable without
  // leaking the full email into the disambiguation surface.
  const [local, domain] = email.split('@');
  if (!local || !domain) return email;
  return `${local.charAt(0)}***@${domain}`;
}

// ---------------------------------------------------------------------------
// Response assembly
// ---------------------------------------------------------------------------

/**
 * Pull an array of rows out of an API envelope that might be `{ data: [...] }`
 * or a bare array. Returns `[]` for anything unrecognized.
 */
function extractRows(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const envelope = data as { data?: unknown };
    if (Array.isArray(envelope.data)) return envelope.data;
  }
  return [];
}

/**
 * Phase 3: decorate near-tied candidates with a disambiguation hint even
 * if their raw hit did not carry one. Runs after Phase 2's per-hit hints
 * so we do not clobber a more specific one.
 */
function applyPhase3Disambiguation(cs: Candidate[]): void {
  const byFragment = new Map<string, Candidate[]>();
  for (const c of cs) {
    const list = byFragment.get(c.source_fragment) ?? [];
    list.push(c);
    byFragment.set(c.source_fragment, list);
  }

  for (const [, group] of byFragment) {
    if (group.length < 2) continue;
    // Find tied clusters within the group
    group.sort((a, b) => b.confidence - a.confidence);
    for (let i = 0; i < group.length - 1; i += 1) {
      const here = group[i]!;
      const next = group[i + 1]!;
      if (Math.abs(here.confidence - next.confidence) <= 0.1 && !here.disambiguation) {
        here.disambiguation = `${group.length} candidates matched "${here.source_fragment}"`;
      }
    }
  }
}

/**
 * De-duplicate by (entity_type, entity_id), keeping the highest-confidence
 * instance and preserving its disambiguation hint.
 */
function dedupeCandidates(cs: Candidate[]): Candidate[] {
  const byId = new Map<string, Candidate>();
  for (const c of cs) {
    const key = `${c.entity_type}:${c.entity_id}`;
    const prev = byId.get(key);
    if (!prev || c.confidence > prev.confidence) {
      byId.set(key, c);
    }
  }
  return Array.from(byId.values());
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerResolveTools(
  server: McpServer,
  api: ApiClient,
  urls: AppUrls,
): void {
  registerTool(server, {
    name: 'resolve_references',
    description:
      'Resolve free text (natural language with optional pinned mention syntax like [[ABC-42]], [[deal:Acme]], @jane, #project) into a ranked list of candidate entities. No LLM. Phase 1 deterministically resolves pinned mentions via lookup endpoints; Phase 2 extracts 2-6 word n-grams (cap 5 phrases) and fans out to every app search endpoint in parallel. Returns ranked candidates with confidence, an optional disambiguation hint when siblings are close, and any fragments that did not resolve.',
    input: {
      text: z.string().min(1).describe('Free text to extract and resolve entity references from.'),
      hints: z
        .array(z.enum(['user', 'task', 'project', 'deal', 'contact', 'company', 'ticket', 'document']))
        .optional()
        .describe('Optional list of entity_type values to prefer. Currently informational; Wave 3 fans out to every type regardless.'),
    },
    returns: z.object({
      candidates: z.array(
        z.object({
          entity_type: z.enum(['user', 'task', 'project', 'deal', 'contact', 'company', 'ticket', 'document']),
          entity_id: z.string(),
          label: z.string(),
          confidence: z.number().min(0).max(1),
          disambiguation: z.string().optional(),
          match_source: z.enum(['pinned', 'search', 'fuzzy']),
          source_fragment: z.string(),
        }),
      ),
      unresolved_fragments: z.array(z.string()),
    }),
    handler: async ({ text }) => {
      const result = await resolveReferences(String(text), api, urls);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
      };
    },
  });
}

/**
 * Pure resolver entry point. Exported for testing so the test suite can
 * drive the pipeline without going through the MCP tool registry.
 */
export async function resolveReferences(
  text: string,
  api: ApiClient,
  urls: AppUrls,
): Promise<ResolveResult> {
  const unresolved: string[] = [];

  // --- Phase 1 ---
  const pinnedCandidates = await resolvePinnedMentions(text, api, urls);

  // Track which pinned mentions failed so they surface in unresolved.
  const pinnedAttempts = extractPinnedMentions(text);
  const resolvedFragments = new Set(pinnedCandidates.map((c) => c.source_fragment));
  for (const attempt of pinnedAttempts) {
    if (!resolvedFragments.has(attempt.fragment)) unresolved.push(attempt.fragment);
  }

  // --- Phase 2 ---
  const remainder = stripPinnedMentions(text);
  const phrases = extractNgramPhrases(remainder);

  const phaseTwoGroups = await Promise.all(
    phrases.map(async (phrase) => ({
      phrase,
      candidates: await resolvePhraseCandidates(phrase, api, urls),
    })),
  );

  const phaseTwoCandidates: Candidate[] = [];
  for (const group of phaseTwoGroups) {
    if (group.candidates.length === 0) {
      unresolved.push(group.phrase);
      continue;
    }
    phaseTwoCandidates.push(...group.candidates);
  }

  // If the input produced no phrases (pure-stopword text) and no pinned
  // mentions resolved, surface the trimmed remainder so the caller knows
  // we looked but found nothing. Without this, a fully unresolvable input
  // returns two empty arrays which is indistinguishable from "empty
  // input".
  if (pinnedCandidates.length === 0 && phaseTwoCandidates.length === 0 && phrases.length === 0) {
    const trimmed = remainder.trim();
    if (trimmed.length > 0) unresolved.push(trimmed);
  }

  // --- Phase 3: disambiguation + dedupe ---
  applyPhase3Disambiguation(phaseTwoCandidates);

  const merged = dedupeCandidates([...pinnedCandidates, ...phaseTwoCandidates]);
  merged.sort((a, b) => b.confidence - a.confidence);

  return {
    candidates: merged.slice(0, 50),
    unresolved_fragments: Array.from(new Set(unresolved)),
  };
}
