import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { isUuid, resolveBeaconId } from '../middleware/resolve-helpers.js';
import { registerTool } from '../lib/register-tool.js';

/**
 * Resolve a Project identifier to a UUID. Accepts either a UUID (passthrough)
 * or a project name (case-insensitive exact match against the caller's
 * visible project list).
 *
 * Beacon-api stores `project_id` as a UUID, and there is no dedicated
 * by-name endpoint on the main API, so we list the caller's projects and
 * filter client-side. `/projects` returns every project the caller can see
 * in their active org, which is typically a small set.
 *
 * Returns `null` if the name does not match any visible project. Callers
 * should surface a clean "Project not found" error.
 */
async function resolveProjectId(api: ApiClient, nameOrId: string): Promise<string | null> {
  if (isUuid(nameOrId)) return nameOrId;
  const result = await api.get('/projects?limit=200');
  if (!result.ok) return null;
  const projects =
    ((result.data as { data?: Array<{ id: string; name: string }> } | null)?.data) ?? [];
  const needle = nameOrId.toLowerCase();
  const match = projects.find((p) => p.name.toLowerCase() === needle);
  return match?.id ?? null;
}

/**
 * Helper to make requests to the beacon-api service.
 * Same pattern as helpdesk-tools.ts / banter-tools.ts — a lightweight fetch
 * wrapper that targets the beacon-api base URL and forwards the user's auth token.
 */
function createBeaconClient(beaconApiUrl: string, api: ApiClient) {
  const baseUrl = beaconApiUrl.replace(/\/$/, '');

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

const beaconShape = z.object({
  id: z.string().uuid(),
  title: z.string(),
  summary: z.string().nullable().optional(),
  status: z.string().optional(),
  visibility: z.string().optional(),
  project_id: z.string().uuid().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

export function registerBeaconTools(server: McpServer, api: ApiClient, beaconApiUrl: string): void {
  const client = createBeaconClient(beaconApiUrl, api);

  // Standard "beacon not found" response when a slug fails to resolve.
  // Write tools call `resolveBeaconId` before hitting their mutation endpoint;
  // this surfaces a clean, actionable error instead of forwarding the slug
  // and getting a generic 400/404 from the underlying service call.
  function beaconNotFound(idOrSlug: string) {
    return {
      content: [{ type: 'text' as const, text: `Beacon not found: ${idOrSlug}` }],
      isError: true as const,
    };
  }

  // ===== CRUD (11) =====

  registerTool(server, {
    name: 'beacon_create',
    description: 'Create a new Beacon (Draft). Provide title, body_markdown, visibility, and optional project scope.',
    input: {
      title: z.string().min(1).max(512).describe('Beacon title'),
      summary: z.string().max(500).optional().describe('Short summary (plain text)'),
      body_markdown: z.string().min(1).max(500_000).describe('Beacon body content (Markdown)'),
      visibility: z.enum(['Public', 'Organization', 'Project', 'Private']).optional().describe('Visibility level'),
      project_id: z
        .string()
        .optional()
        .describe('Project scope (if project-level) — accepts a UUID or project name'),
    },
    returns: beaconShape,
    handler: async (params) => {
      const body: Record<string, unknown> = { ...params };
      if (params.project_id) {
        const resolved = await resolveProjectId(api, params.project_id);
        if (!resolved) {
          return {
            content: [
              { type: 'text' as const, text: `Project not found: ${params.project_id}` },
            ],
            isError: true as const,
          };
        }
        body.project_id = resolved;
      }
      const result = await client.request('POST', '/beacons', body);
      return result.ok ? ok(result.data) : err('creating beacon', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_list',
    description: 'List Beacons with optional filters and pagination.',
    input: {
      status: z.enum(['Draft', 'Active', 'PendingReview', 'Archived', 'Retired']).optional().describe('Filter by status'),
      project_id: z.string().uuid().optional().describe('Filter by project'),
      tags: z.string().optional().describe('Comma-separated tag filter'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(100).optional().describe('Page size (default 50, max 100)'),
      sort: z.string().optional().describe('Sort field (e.g. -updated_at)'),
    },
    returns: z.object({ data: z.array(beaconShape), next_cursor: z.string().nullable().optional() }),
    handler: async (params) => {
      const result = await client.request('GET', `/beacons${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing beacons', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_get',
    description: 'Retrieve a single Beacon by ID or slug.',
    input: {
      id: z.string().describe('Beacon ID (UUID) or slug'),
    },
    returns: beaconShape.extend({ body_markdown: z.string().optional(), version: z.number().optional() }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/beacons/${id}`);
      return result.ok ? ok(result.data) : err('getting beacon', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_update',
    description: 'Update a Beacon (creates a new version). Provide only the fields to change.',
    input: {
      id: z.string().describe('Beacon ID (UUID), slug, or title'),
      title: z.string().min(1).max(512).optional().describe('Updated title'),
      summary: z.string().max(500).optional().describe('Updated summary'),
      body_markdown: z.string().min(1).max(500_000).optional().describe('Updated body content (Markdown)'),
      visibility: z.enum(['Public', 'Organization', 'Project', 'Private']).optional().describe('Updated visibility'),
      change_note: z.string().max(500).optional().describe('Note describing what changed'),
    },
    returns: beaconShape,
    handler: async ({ id, ...body }) => {
      const beaconId = await resolveBeaconId(client, id);
      if (!beaconId) return beaconNotFound(id);
      const result = await client.request('PUT', `/beacons/${beaconId}`, body);
      return result.ok ? ok(result.data) : err('updating beacon', result.data);
    },
  });

  // §14 Wave 4: idempotent create-or-update by slug.
  registerTool(server, {
    name: 'beacon_upsert_by_slug',
    description: 'Idempotent create-or-update of a Beacon entry by slug. Natural key is the globally-unique slug. On update, bumps version and writes a beacon_versions snapshot. Returns { data, created, idempotency_key } — `created` is true on insert, false on update.',
    input: {
      slug: z.string().min(1).max(256).describe('Slug — idempotency key (must be a URL-safe string)'),
      title: z.string().min(1).max(512).describe('Entry title'),
      summary: z.string().max(500).nullable().optional().describe('Short summary (plain text)'),
      body_markdown: z.string().min(1).max(500_000).describe('Entry body (Markdown)'),
      body_html: z.string().nullable().optional().describe('Optional pre-rendered HTML (sanitized server-side)'),
      visibility: z.enum(['Public', 'Organization', 'Project', 'Private']).optional().describe('Visibility level'),
      project_id: z.string().uuid().nullable().optional().describe('Project scope (UUID)'),
      metadata: z.record(z.unknown()).optional().describe('Arbitrary metadata JSON'),
      change_note: z.string().max(500).nullable().optional().describe('Note attached to the new version row on update'),
    },
    returns: z.object({
      data: beaconShape.extend({ body_markdown: z.string().optional(), version: z.number().optional() }),
      created: z.boolean(),
      idempotency_key: z.string(),
    }),
    handler: async (params) => {
      const result = await client.request('POST', '/entries/upsert', params);
      return result.ok ? ok(result.data) : err('upserting beacon entry', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_retire',
    description: 'Retire (soft-delete) a Beacon.',
    input: {
      id: z.string().describe('Beacon ID (UUID), slug, or title'),
    },
    returns: z.object({ ok: z.boolean() }),
    handler: async ({ id }) => {
      const beaconId = await resolveBeaconId(client, id);
      if (!beaconId) return beaconNotFound(id);
      const result = await client.request('DELETE', `/beacons/${beaconId}`);
      return result.ok ? ok(result.data) : err('retiring beacon', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_publish',
    description: 'Transition a Beacon from Draft to Active.',
    input: {
      id: z.string().describe('Beacon ID (UUID), slug, or title'),
    },
    returns: beaconShape,
    handler: async ({ id }) => {
      const beaconId = await resolveBeaconId(client, id);
      if (!beaconId) return beaconNotFound(id);
      const result = await client.request('POST', `/beacons/${beaconId}/publish`);
      return result.ok ? ok(result.data) : err('publishing beacon', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_verify',
    description: 'Record a verification event on a Beacon (confirms content is still accurate).',
    input: {
      id: z.string().describe('Beacon ID (UUID), slug, or title'),
      verification_type: z.enum(['Manual', 'AgentAutomatic', 'AgentAssisted', 'ScheduledReview']).describe('Type of verification'),
      outcome: z.enum(['Confirmed', 'Updated', 'Challenged', 'Retired']).describe('Verification outcome'),
      confidence_score: z.number().min(0).max(1).optional().describe('Confidence score (0-1)'),
      notes: z.string().max(1000).optional().describe('Optional verification notes'),
    },
    returns: z.object({ id: z.string().uuid(), outcome: z.string(), verified_at: z.string() }).passthrough(),
    handler: async ({ id, ...body }) => {
      const beaconId = await resolveBeaconId(client, id);
      if (!beaconId) return beaconNotFound(id);
      const result = await client.request('POST', `/beacons/${beaconId}/verify`, body);
      return result.ok ? ok(result.data) : err('verifying beacon', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_challenge',
    description: 'Flag a Beacon for review (challenge its accuracy or relevance).',
    input: {
      id: z.string().describe('Beacon ID (UUID), slug, or title'),
      reason: z.string().max(1000).optional().describe('Reason for the challenge'),
    },
    returns: beaconShape,
    handler: async ({ id, ...body }) => {
      const beaconId = await resolveBeaconId(client, id);
      if (!beaconId) return beaconNotFound(id);
      const result = await client.request('POST', `/beacons/${beaconId}/challenge`, Object.keys(body).length ? body : undefined);
      return result.ok ? ok(result.data) : err('challenging beacon', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_restore',
    description: 'Restore an Archived Beacon back to Active status.',
    input: {
      id: z.string().describe('Beacon ID (UUID), slug, or title'),
    },
    returns: beaconShape,
    handler: async ({ id }) => {
      const beaconId = await resolveBeaconId(client, id);
      if (!beaconId) return beaconNotFound(id);
      const result = await client.request('POST', `/beacons/${beaconId}/restore`);
      return result.ok ? ok(result.data) : err('restoring beacon', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_versions',
    description: 'List the version history of a Beacon.',
    input: {
      id: z.string().describe('Beacon ID (UUID), slug, or title'),
    },
    returns: z.object({ data: z.array(z.object({ version: z.number(), created_at: z.string(), change_note: z.string().nullable().optional() }).passthrough()) }),
    handler: async ({ id }) => {
      const beaconId = await resolveBeaconId(client, id);
      if (!beaconId) return beaconNotFound(id);
      const result = await client.request('GET', `/beacons/${beaconId}/versions`);
      return result.ok ? ok(result.data) : err('listing beacon versions', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_version_get',
    description: 'Get a specific version of a Beacon.',
    input: {
      id: z.string().describe('Beacon ID (UUID), slug, or title'),
      version: z.number().int().positive().describe('Version number'),
    },
    returns: beaconShape.extend({ version: z.number(), body_markdown: z.string().optional() }),
    handler: async ({ id, version }) => {
      const beaconId = await resolveBeaconId(client, id);
      if (!beaconId) return beaconNotFound(id);
      const result = await client.request('GET', `/beacons/${beaconId}/versions/${version}`);
      return result.ok ? ok(result.data) : err('getting beacon version', result.data);
    },
  });

  // ===== SEARCH (4) =====

  registerTool(server, {
    name: 'beacon_search',
    description: 'Hybrid semantic + keyword + graph search across Beacons.',
    input: {
      query: z.string().describe('Search query text'),
      filters: z.object({
        project_ids: z.array(z.string().uuid()).optional().describe('Limit to specific projects'),
        tags: z.array(z.string()).optional().describe('Filter by tags'),
        status: z.array(z.string()).optional().describe('Filter by status (e.g. Active, PendingReview)'),
        visibility_max: z.enum(['Public', 'Organization', 'Project', 'Private']).optional().describe('Visibility ceiling'),
        expires_after: z.string().optional().describe('ISO timestamp — only Beacons expiring after this date'),
      }).optional().describe('Search filters'),
      options: z.object({
        include_graph_expansion: z.boolean().optional().describe('Follow beacon_links from top results'),
        include_tag_expansion: z.boolean().optional().describe('Expand by shared tags'),
        include_fulltext_fallback: z.boolean().optional().describe('PostgreSQL ts_vector fallback'),
      }).optional().describe('Retrieval options'),
      top_k: z.number().int().min(0).max(100).optional().describe('Number of results (0 = count only)'),
      cursor: z.string().optional().describe('Pagination cursor'),
    },
    returns: z.object({ data: z.array(beaconShape.extend({ score: z.number().optional() })), next_cursor: z.string().nullable().optional(), total: z.number().optional() }),
    handler: async (params) => {
      const result = await client.request('POST', '/search', params);
      return result.ok ? ok(result.data) : err('searching beacons', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_suggest',
    description: 'Typeahead suggestions from the Beacon title/tag index.',
    input: {
      q: z.string().min(1).describe('Partial query text'),
      limit: z.number().int().positive().max(20).optional().describe('Max suggestions (default 10)'),
    },
    returns: z.object({ suggestions: z.array(z.object({ id: z.string(), title: z.string(), type: z.string().optional() }).passthrough()) }),
    handler: async (params) => {
      const result = await client.request('GET', `/search/suggest${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('getting suggestions', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_search_context',
    description: 'Structured retrieval optimized for agent consumption — richer metadata, linked Beacons pre-fetched.',
    input: {
      query: z.string().describe('Search query text'),
      filters: z.object({
        project_ids: z.array(z.string().uuid()).optional(),
        tags: z.array(z.string()).optional(),
        status: z.array(z.string()).optional(),
      }).optional().describe('Search filters'),
      top_k: z.number().int().min(1).max(50).optional().describe('Number of results'),
    },
    returns: z.object({ data: z.array(beaconShape.extend({ score: z.number().optional(), linked_beacons: z.array(beaconShape).optional() })) }),
    handler: async (params) => {
      const result = await client.request('POST', '/search/context', params);
      return result.ok ? ok(result.data) : err('searching beacon context', result.data);
    },
  });

  // ===== POLICY (3) =====

  registerTool(server, {
    name: 'beacon_policy_get',
    description: 'Get the effective Beacon governance policy for the current scope.',
    input: {
      project_id: z.string().uuid().optional().describe('Project ID (omit for org-level policy)'),
    },
    returns: z.object({ verification_interval_days: z.number().optional(), grace_period_days: z.number().optional(), auto_archive: z.boolean().optional(), tag_affinity_threshold: z.number().optional() }).passthrough(),
    handler: async (params) => {
      const result = await client.request('GET', `/policies${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('getting policy', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_policy_set',
    description: 'Set or update the Beacon governance policy at a given scope level.',
    input: {
      project_id: z.string().uuid().optional().describe('Project ID (omit for org-level)'),
      verification_interval_days: z.number().int().positive().optional().describe('Days between required verifications'),
      grace_period_days: z.number().int().min(0).optional().describe('Grace period before archiving'),
      auto_archive: z.boolean().optional().describe('Whether to auto-archive expired Beacons'),
      tag_affinity_threshold: z.number().int().min(1).max(5).optional().describe('Min shared tags for implicit graph edges'),
    },
    returns: z.object({ ok: z.boolean() }).passthrough(),
    handler: async (params) => {
      const result = await client.request('PUT', '/policies', params);
      return result.ok ? ok(result.data) : err('setting policy', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_policy_resolve',
    description: 'Preview the resolved effective policy (merging org + project levels).',
    input: {
      project_id: z.string().uuid().optional().describe('Project ID to resolve for'),
    },
    returns: z.object({ verification_interval_days: z.number().optional(), grace_period_days: z.number().optional(), auto_archive: z.boolean().optional(), tag_affinity_threshold: z.number().optional(), source: z.string().optional() }).passthrough(),
    handler: async (params) => {
      const result = await client.request('GET', `/policies/resolve${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('resolving policy', result.data);
    },
  });

  // ===== TAGS & LINKS (5) =====

  registerTool(server, {
    name: 'beacon_tags_list',
    description: 'List all tags in scope with usage counts.',
    input: {
      project_id: z.string().uuid().optional().describe('Filter tags by project scope'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(200).optional().describe('Page size'),
    },
    returns: z.object({ data: z.array(z.object({ tag: z.string(), count: z.number() }).passthrough()), next_cursor: z.string().nullable().optional() }),
    handler: async (params) => {
      const result = await client.request('GET', `/tags${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing tags', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_tag_add',
    description: 'Add one or more tags to a Beacon.',
    input: {
      id: z.string().describe('Beacon ID (UUID), slug, or title'),
      tags: z.array(z.string().min(1)).min(1).describe('Tags to add'),
    },
    returns: z.object({ tags: z.array(z.string()) }),
    handler: async ({ id, tags }) => {
      const beaconId = await resolveBeaconId(client, id);
      if (!beaconId) return beaconNotFound(id);
      const result = await client.request('POST', `/beacons/${beaconId}/tags`, { tags });
      return result.ok ? ok(result.data) : err('adding tags', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_tag_remove',
    description: 'Remove a tag from a Beacon.',
    input: {
      id: z.string().describe('Beacon ID (UUID), slug, or title'),
      tag: z.string().min(1).describe('Tag to remove'),
    },
    returns: z.object({ ok: z.boolean() }),
    handler: async ({ id, tag }) => {
      const beaconId = await resolveBeaconId(client, id);
      if (!beaconId) return beaconNotFound(id);
      const result = await client.request('DELETE', `/beacons/${beaconId}/tags/${encodeURIComponent(tag)}`);
      return result.ok ? ok(result.data) : err('removing tag', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_link_create',
    description: 'Create a typed link between two Beacons.',
    input: {
      id: z.string().describe('Source Beacon ID (UUID), slug, or title'),
      target_id: z.string().describe('Target Beacon ID (UUID), slug, or title'),
      link_type: z.enum(['RelatedTo', 'Supersedes', 'DependsOn', 'ConflictsWith', 'SeeAlso']).describe('Link type'),
    },
    returns: z.object({ id: z.string().uuid(), link_type: z.string(), source_id: z.string().uuid(), target_id: z.string().uuid() }).passthrough(),
    handler: async ({ id, target_id, link_type }) => {
      const beaconId = await resolveBeaconId(client, id);
      if (!beaconId) return beaconNotFound(id);
      const targetId = await resolveBeaconId(client, target_id);
      if (!targetId) return beaconNotFound(target_id);
      const result = await client.request('POST', `/beacons/${beaconId}/links`, {
        target_id: targetId,
        link_type,
      });
      return result.ok ? ok(result.data) : err('creating link', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_link_remove',
    description: 'Remove a link from a Beacon.',
    input: {
      id: z.string().describe('Source Beacon ID (UUID), slug, or title'),
      link_id: z.string().uuid().describe('Link ID to remove'),
    },
    returns: z.object({ ok: z.boolean() }),
    handler: async ({ id, link_id }) => {
      const beaconId = await resolveBeaconId(client, id);
      if (!beaconId) return beaconNotFound(id);
      const result = await client.request('DELETE', `/beacons/${beaconId}/links/${link_id}`);
      return result.ok ? ok(result.data) : err('removing link', result.data);
    },
  });

  // ===== SAVED QUERIES (4) =====

  registerTool(server, {
    name: 'beacon_query_save',
    description: 'Save a named search query configuration for reuse.',
    input: {
      name: z.string().min(1).max(200).describe('Query name'),
      description: z.string().max(500).optional().describe('Short description'),
      query_body: z.record(z.unknown()).describe('Serialized search request body (same schema as beacon_search params)'),
      scope: z.enum(['Private', 'Project', 'Organization']).optional().describe('Sharing scope (default Private)'),
      project_id: z.string().uuid().optional().describe('Project ID (required if scope = Project)'),
    },
    returns: z.object({ id: z.string().uuid(), name: z.string(), created_at: z.string() }).passthrough(),
    handler: async (params) => {
      const result = await client.request('POST', '/search/saved', params);
      return result.ok ? ok(result.data) : err('saving query', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_query_list',
    description: 'List saved queries (own + shared in scope).',
    input: {
      scope: z.enum(['Private', 'Project', 'Organization']).optional().describe('Filter by scope'),
      project_id: z.string().uuid().optional().describe('Filter by project'),
    },
    returns: z.object({ data: z.array(z.object({ id: z.string().uuid(), name: z.string(), scope: z.string() }).passthrough()) }),
    handler: async (params) => {
      const result = await client.request('GET', `/search/saved${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing saved queries', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_query_get',
    description: 'Retrieve a saved query by ID.',
    input: {
      id: z.string().uuid().describe('Saved query ID'),
    },
    returns: z.object({ id: z.string().uuid(), name: z.string(), query_body: z.record(z.unknown()) }).passthrough(),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/search/saved/${id}`);
      return result.ok ? ok(result.data) : err('getting saved query', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_query_delete',
    description: 'Delete a saved query (owner only).',
    input: {
      id: z.string().uuid().describe('Saved query ID'),
    },
    returns: z.object({ ok: z.boolean() }),
    handler: async ({ id }) => {
      const result = await client.request('DELETE', `/search/saved/${id}`);
      return result.ok ? ok(result.data) : err('deleting saved query', result.data);
    },
  });

  // ===== GRAPH (3) =====

  registerTool(server, {
    name: 'beacon_graph_neighbors',
    description: 'Get nodes and edges within N hops of a focal Beacon for graph exploration.',
    input: {
      beacon_id: z.string().describe('Focal Beacon ID (UUID), slug, or title'),
      hops: z.number().int().min(1).max(3).optional().describe('Traversal depth (default 1)'),
      include_implicit: z.boolean().optional().describe('Include tag-affinity edges (default true)'),
      tag_affinity_threshold: z.number().int().min(1).max(5).optional().describe('Minimum shared tags for implicit edge (default 2)'),
      status: z.string().optional().describe('Comma-separated status filter (e.g. Active,PendingReview)'),
    },
    returns: z.object({ nodes: z.array(beaconShape), edges: z.array(z.object({ source_id: z.string().uuid(), target_id: z.string().uuid(), link_type: z.string() }).passthrough()) }),
    handler: async (params) => {
      const resolved = await resolveBeaconId(client, params.beacon_id);
      if (!resolved) return beaconNotFound(params.beacon_id);
      const result = await client.request(
        'GET',
        `/graph/neighbors${buildQs({ ...params, beacon_id: resolved })}`,
      );
      return result.ok ? ok(result.data) : err('getting graph neighbors', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_graph_hubs',
    description: 'Get the most-connected Beacons in scope (hub nodes for Knowledge Home).',
    input: {
      scope: z.enum(['project', 'organization']).optional().describe('Scope level (default project)'),
      project_id: z.string().uuid().optional().describe('Project ID (required if scope = project)'),
      top_k: z.number().int().min(1).max(50).optional().describe('Number of hub nodes (default 20)'),
    },
    returns: z.object({ data: z.array(beaconShape.extend({ connection_count: z.number().optional() })) }),
    handler: async (params) => {
      const result = await client.request('GET', `/graph/hubs${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('getting graph hubs', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_graph_recent',
    description: 'Get recently modified or verified Beacons.',
    input: {
      scope: z.enum(['project', 'organization']).optional().describe('Scope level (default project)'),
      project_id: z.string().uuid().optional().describe('Project ID (required if scope = project)'),
      days: z.number().int().min(1).max(90).optional().describe('Lookback window in days (default 7)'),
    },
    returns: z.object({ data: z.array(beaconShape) }),
    handler: async (params) => {
      const result = await client.request('GET', `/graph/recent${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('getting recent beacons', result.data);
    },
  });

  // ===== Stats, links, comments, attachments (endpoint-parity additions) =====
  //
  // Read + comment/link/attachment management endpoints that previously had no
  // MCP tool. The multipart attachment UPLOAD (POST /beacons/:id/attachments)
  // is intentionally NOT exposed — binary multipart upload is not an
  // agent-appropriate surface; agents reference existing attachments via the
  // cross-cutting attachment_get / attachment_list tools. `GET /beacons/by-slug/:slug`
  // is also not a standalone tool: it is the slug resolver that resolveBeaconId
  // already performs internally for every write tool.

  const commentShape = z
    .object({
      id: z.string().uuid(),
      beacon_id: z.string().uuid().optional(),
      author_id: z.string().uuid().optional(),
      parent_id: z.string().uuid().nullable().optional(),
      body_markdown: z.string().optional(),
      created_at: z.string().optional(),
    })
    .passthrough();

  registerTool(server, {
    name: 'beacon_stats',
    description: 'Org-wide Beacon statistics (counts by status, staleness, verification) for the active scope.',
    input: {
      project_id: z.string().uuid().optional().describe('Optional project scope filter'),
    },
    returns: z.object({}).passthrough().describe('Aggregated stats — shape varies'),
    handler: async (params) => {
      const result = await client.request('GET', `/beacons/stats${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('getting beacon stats', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_links_list',
    description: "List a Beacon's typed links (related/depends-on/etc.). `id` accepts a UUID, slug, or title.",
    input: {
      id: z.string().describe('Beacon UUID, slug, or title'),
    },
    returns: z.object({ data: z.array(z.object({ id: z.string().uuid() }).passthrough()) }),
    handler: async ({ id }) => {
      const beaconId = await resolveBeaconId(client, id);
      if (!beaconId) return beaconNotFound(id);
      const result = await client.request('GET', `/beacons/${beaconId}/links`);
      return result.ok ? ok(result.data) : err('listing beacon links', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_comments_list',
    description: 'List all comments on a Beacon (threaded). `id` accepts a UUID, slug, or title.',
    input: {
      id: z.string().describe('Beacon UUID, slug, or title'),
    },
    returns: z.object({ data: z.array(commentShape) }),
    handler: async ({ id }) => {
      const beaconId = await resolveBeaconId(client, id);
      if (!beaconId) return beaconNotFound(id);
      const result = await client.request('GET', `/beacons/${beaconId}/comments`);
      return result.ok ? ok(result.data) : err('listing beacon comments', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_comment_add',
    description: 'Add a comment to a Beacon, optionally as a reply to another comment. `id` accepts a UUID, slug, or title.',
    input: {
      id: z.string().describe('Beacon UUID, slug, or title'),
      body_markdown: z.string().min(1).max(20_000).describe('Comment body (Markdown)'),
      parent_id: z.string().uuid().optional().describe('Parent comment ID to reply to'),
    },
    returns: commentShape,
    handler: async ({ id, body_markdown, parent_id }) => {
      const beaconId = await resolveBeaconId(client, id);
      if (!beaconId) return beaconNotFound(id);
      const result = await client.request('POST', `/beacons/${beaconId}/comments`, {
        body_markdown,
        parent_id: parent_id ?? null,
      });
      return result.ok ? ok(result.data) : err('adding beacon comment', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_comment_edit',
    description: "Edit a comment's body (author only). `id` accepts a UUID, slug, or title.",
    input: {
      id: z.string().describe('Beacon UUID, slug, or title'),
      comment_id: z.string().uuid().describe('Comment ID to edit'),
      body_markdown: z.string().min(1).max(20_000).describe('New comment body (Markdown)'),
    },
    returns: commentShape,
    handler: async ({ id, comment_id, body_markdown }) => {
      const beaconId = await resolveBeaconId(client, id);
      if (!beaconId) return beaconNotFound(id);
      const result = await client.request('PUT', `/beacons/${beaconId}/comments/${comment_id}`, {
        body_markdown,
      });
      return result.ok ? ok(result.data) : err('editing beacon comment', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_comment_delete',
    description: 'Delete a comment from a Beacon (author or admin). `id` accepts a UUID, slug, or title.',
    input: {
      id: z.string().describe('Beacon UUID, slug, or title'),
      comment_id: z.string().uuid().describe('Comment ID to delete'),
    },
    returns: z.object({ data: z.object({}).passthrough() }).passthrough(),
    handler: async ({ id, comment_id }) => {
      const beaconId = await resolveBeaconId(client, id);
      if (!beaconId) return beaconNotFound(id);
      const result = await client.request('DELETE', `/beacons/${beaconId}/comments/${comment_id}`);
      return result.ok ? ok(result.data) : err('deleting beacon comment', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_attachments_list',
    description: "List a Beacon's attachments. `id` accepts a UUID, slug, or title.",
    input: {
      id: z.string().describe('Beacon UUID, slug, or title'),
    },
    returns: z.object({ data: z.array(z.object({ id: z.string().uuid() }).passthrough()) }),
    handler: async ({ id }) => {
      const beaconId = await resolveBeaconId(client, id);
      if (!beaconId) return beaconNotFound(id);
      const result = await client.request('GET', `/beacons/${beaconId}/attachments`);
      return result.ok ? ok(result.data) : err('listing beacon attachments', result.data);
    },
  });

  registerTool(server, {
    name: 'beacon_attachment_delete',
    description: 'Delete an attachment from a Beacon. `id` accepts a UUID, slug, or title.',
    input: {
      id: z.string().describe('Beacon UUID, slug, or title'),
      attachment_id: z.string().uuid().describe('Attachment ID to delete'),
    },
    returns: z.object({}).passthrough(),
    handler: async ({ id, attachment_id }) => {
      const beaconId = await resolveBeaconId(client, id);
      if (!beaconId) return beaconNotFound(id);
      const result = await client.request('DELETE', `/beacons/${beaconId}/attachments/${attachment_id}`);
      return result.ok ? ok(result.data) : err('deleting beacon attachment', result.data);
    },
  });
}
