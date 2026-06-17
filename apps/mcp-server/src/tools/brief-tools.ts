import { registerTool } from '../lib/register-tool.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import {
  resolveDocumentId,
  resolveProjectId,
  resolveTaskId,
} from '../middleware/resolve-helpers.js';

/**
 * Helper to make requests to the brief-api service.
 * Same pattern as beacon-tools.ts — a lightweight fetch wrapper that targets
 * the brief-api base URL and forwards the user's auth token.
 */
function createBriefClient(briefApiUrl: string, api: ApiClient) {
  const baseUrl = briefApiUrl.replace(/\/$/, '');

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

const docShape = z.object({
  id: z.string().uuid(),
  title: z.string().nullable().optional(),
  status: z.string().optional(),
  visibility: z.string().optional(),
  project_id: z.string().uuid().nullable().optional(),
  created_by: z.string().uuid().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

const briefCommentShape = z.object({
  id: z.string().uuid(),
  document_id: z.string().uuid(),
  body: z.string(),
  resolved: z.boolean().optional(),
  created_at: z.string(),
}).passthrough();

const versionShape = z.object({
  id: z.string().uuid(),
  document_id: z.string().uuid(),
  version_number: z.number().optional(),
  created_at: z.string(),
}).passthrough();

export function registerBriefTools(server: McpServer, api: ApiClient, briefApiUrl: string): void {
  const client = createBriefClient(briefApiUrl, api);

  // Standard "document not found" response when a slug fails to resolve.
  // Write tools call `resolveDocumentId` before hitting their mutation
  // endpoint; this surfaces a clean, actionable error instead of forwarding
  // the slug and getting a generic 400/404 from the underlying service call.
  function documentNotFound(idOrSlug: string) {
    return {
      content: [{ type: 'text' as const, text: `Brief document not found: ${idOrSlug}` }],
      isError: true as const,
    };
  }

  // ===== DOCUMENTS CRUD (9) =====

  registerTool(server, {
    name: 'brief_list',
    description: 'List Brief documents with optional filters and pagination.',
    input: {
      project_id: z.string().uuid().optional().describe('Filter by project'),
      folder_id: z.string().uuid().optional().describe('Filter by folder'),
      status: z.enum(['draft', 'in_review', 'approved', 'archived']).optional().describe('Filter by document status'),
      created_by: z.string().uuid().optional().describe('Filter by author user ID'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(100).optional().describe('Page size (default 50, max 100)'),
    },
    returns: z.object({ data: z.array(docShape), next_cursor: z.string().nullable().optional() }),
    handler: async (params) => {
      const result = await client.request('GET', `/documents${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing documents', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_get',
    description: 'Retrieve a single Brief document by ID or slug.',
    input: {
      id: z.string().describe('Document ID (UUID) or slug'),
    },
    returns: docShape.extend({ content: z.string().optional() }),
    handler: async ({ id }) => {
      const result = await client.request('GET', `/documents/${id}`);
      return result.ok ? ok(result.data) : err('getting document', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_create',
    description: 'Create a new Brief document.',
    input: {
      title: z.string().max(500).optional().describe('Document title (max 500 chars)'),
      project_id: z.string().uuid().optional().describe('Project to create the document in'),
      folder_id: z.string().uuid().optional().describe('Folder to place the document in'),
      template_id: z.string().uuid().optional().describe('Template to base the document on'),
      content: z.string().max(500_000).optional().describe('Initial Markdown content (max 500k chars)'),
      visibility: z.enum(['private', 'project', 'organization']).optional().describe('Document visibility level'),
    },
    returns: docShape,
    handler: async (params) => {
      const result = await client.request('POST', '/documents', params);
      return result.ok ? ok(result.data) : err('creating document', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_update',
    description: 'Update Brief document metadata. Provide only the fields to change.',
    input: {
      id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
      title: z.string().max(500).optional().describe('Updated title'),
      status: z.enum(['draft', 'in_review', 'approved', 'archived']).optional().describe('Updated status'),
      visibility: z.enum(['private', 'project', 'organization']).optional().describe('Updated visibility'),
      folder_id: z.string().uuid().optional().describe('Move to a different folder'),
      icon: z.string().max(100).optional().describe('Document icon (emoji or icon name)'),
      pinned: z.boolean().optional().describe('Pin document to top of list'),
    },
    returns: docShape,
    handler: async ({ id, ...body }) => {
      const documentId = await resolveDocumentId(client, id);
      if (!documentId) return documentNotFound(id);
      const result = await client.request('PATCH', `/documents/${documentId}`, body);
      return result.ok ? ok(result.data) : err('updating document', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_update_content',
    description: 'Replace the entire content of a Brief document with new Markdown.',
    input: {
      id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
      content: z.string().max(500_000).describe('New Markdown content (max 500k chars)'),
    },
    returns: docShape,
    handler: async ({ id, content }) => {
      const documentId = await resolveDocumentId(client, id);
      if (!documentId) return documentNotFound(id);
      const result = await client.request('PUT', `/documents/${documentId}/content`, { content });
      return result.ok ? ok(result.data) : err('updating document content', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_append_content',
    description: 'Append Markdown content to the end of a Brief document.',
    input: {
      id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
      content: z.string().max(100_000).describe('Markdown to append (max 100k chars)'),
    },
    returns: docShape,
    handler: async ({ id, content }) => {
      const documentId = await resolveDocumentId(client, id);
      if (!documentId) return documentNotFound(id);
      const result = await client.request('POST', `/documents/${documentId}/append`, { content });
      return result.ok ? ok(result.data) : err('appending to document', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_archive',
    description: 'Archive a Brief document (soft-delete).',
    input: {
      id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
    },
    returns: z.object({ ok: z.boolean() }),
    handler: async ({ id }) => {
      const documentId = await resolveDocumentId(client, id);
      if (!documentId) return documentNotFound(id);
      const result = await client.request('DELETE', `/documents/${documentId}`);
      return result.ok ? ok(result.data) : err('archiving document', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_restore',
    description: 'Restore an archived Brief document.',
    input: {
      id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
    },
    returns: docShape,
    handler: async ({ id }) => {
      const documentId = await resolveDocumentId(client, id);
      if (!documentId) return documentNotFound(id);
      const result = await client.request('POST', `/documents/${documentId}/restore`);
      return result.ok ? ok(result.data) : err('restoring document', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_duplicate',
    description: 'Duplicate a Brief document, optionally into a different project.',
    input: {
      id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
      project_id: z
        .string()
        .optional()
        .describe('Target project UUID or exact project name (defaults to same project)'),
    },
    returns: docShape,
    handler: async ({ id, project_id }) => {
      const documentId = await resolveDocumentId(client, id);
      if (!documentId) return documentNotFound(id);

      // Resolve an optional human-readable project name (e.g. "Mage Inc") to
      // its UUID. The Bam API's list endpoint enforces org + membership, so
      // this cannot leak projects the caller can't already see.
      let resolvedProjectId: string | undefined;
      if (project_id !== undefined) {
        const pid = await resolveProjectId(api, project_id);
        if (!pid) {
          return {
            content: [
              { type: 'text' as const, text: `Project not found: ${project_id}` },
            ],
            isError: true as const,
          };
        }
        resolvedProjectId = pid;
      }

      const body = resolvedProjectId ? { project_id: resolvedProjectId } : undefined;
      const result = await client.request(
        'POST',
        `/documents/${documentId}/duplicate`,
        body,
      );
      return result.ok ? ok(result.data) : err('duplicating document', result.data);
    },
  });

  // ===== SEARCH (1) =====

  registerTool(server, {
    name: 'brief_search',
    description: 'Search Brief documents by keyword or semantic similarity.',
    input: {
      query: z.string().max(500).describe('Search query text (max 500 chars)'),
      project_id: z.string().uuid().optional().describe('Filter by project'),
      status: z.enum(['draft', 'in_review', 'approved', 'archived']).optional().describe('Filter by status'),
      semantic: z.boolean().optional().describe('Enable semantic (vector) search (default false)'),
      limit: z.number().int().positive().max(100).optional().describe('Max results (default 50, max 100)'),
    },
    returns: z.object({ data: z.array(docShape), next_cursor: z.string().nullable().optional() }),
    handler: async (params) => {
      const result = await client.request('GET', `/documents/search${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('searching documents', result.data);
    },
  });

  // ===== COMMENTS (3) =====

  registerTool(server, {
    name: 'brief_comment_list',
    description: 'List comments on a Brief document.',
    input: {
      document_id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
    },
    returns: z.object({ data: z.array(briefCommentShape) }),
    handler: async ({ document_id }) => {
      const resolved = await resolveDocumentId(client, document_id);
      if (!resolved) return documentNotFound(document_id);
      const result = await client.request('GET', `/documents/${resolved}/comments`);
      return result.ok ? ok(result.data) : err('listing comments', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_comment_add',
    description: 'Add a comment to a Brief document, optionally as a reply or anchored to specific text.',
    input: {
      document_id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
      body: z.string().max(10_000).describe('Comment body text (max 10k chars)'),
      parent_id: z.string().uuid().optional().describe('Parent comment ID for threaded reply'),
      anchor_text: z.string().max(500).optional().describe('Text selection the comment is anchored to (max 500 chars)'),
    },
    returns: briefCommentShape,
    handler: async ({ document_id, ...body }) => {
      const resolved = await resolveDocumentId(client, document_id);
      if (!resolved) return documentNotFound(document_id);
      const result = await client.request('POST', `/documents/${resolved}/comments`, body);
      return result.ok ? ok(result.data) : err('adding comment', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_comment_resolve',
    description: 'Toggle the resolved state of a comment.',
    input: {
      comment_id: z.string().uuid().describe('Comment ID'),
    },
    returns: briefCommentShape,
    handler: async ({ comment_id }) => {
      const result = await client.request('POST', `/comments/${comment_id}/resolve`);
      return result.ok ? ok(result.data) : err('resolving comment', result.data);
    },
  });

  // ===== VERSIONS (3) =====

  registerTool(server, {
    name: 'brief_versions',
    description: 'List the version history of a Brief document.',
    input: {
      document_id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
    },
    returns: z.object({ data: z.array(versionShape) }),
    handler: async ({ document_id }) => {
      const resolved = await resolveDocumentId(client, document_id);
      if (!resolved) return documentNotFound(document_id);
      const result = await client.request('GET', `/documents/${resolved}/versions`);
      return result.ok ? ok(result.data) : err('listing versions', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_version_get',
    description: 'Get a specific version of a Brief document.',
    input: {
      document_id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
      version_id: z.string().uuid().describe('Version ID'),
    },
    returns: versionShape.extend({ content: z.string().optional() }),
    handler: async ({ document_id, version_id }) => {
      const resolved = await resolveDocumentId(client, document_id);
      if (!resolved) return documentNotFound(document_id);
      const result = await client.request('GET', `/documents/${resolved}/versions/${version_id}`);
      return result.ok ? ok(result.data) : err('getting version', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_version_restore',
    description: 'Restore a Brief document to a specific previous version.',
    input: {
      document_id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
      version_id: z.string().uuid().describe('Version ID to restore'),
    },
    returns: docShape,
    handler: async ({ document_id, version_id }) => {
      const resolved = await resolveDocumentId(client, document_id);
      if (!resolved) return documentNotFound(document_id);
      const result = await client.request('POST', `/documents/${resolved}/versions/${version_id}/restore`);
      return result.ok ? ok(result.data) : err('restoring version', result.data);
    },
  });

  // ===== INTEGRATIONS (2) =====

  registerTool(server, {
    name: 'brief_promote_to_beacon',
    description: 'Graduate a Brief document to a Beacon knowledge article.',
    input: {
      id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match) to promote'),
    },
    returns: z.object({ beacon_id: z.string().uuid(), document_id: z.string().uuid() }).passthrough(),
    handler: async ({ id }) => {
      const documentId = await resolveDocumentId(client, id);
      if (!documentId) return documentNotFound(id);
      const result = await client.request('POST', `/documents/${documentId}/promote`);
      return result.ok ? ok(result.data) : err('promoting document to beacon', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_link_task',
    description: 'Link a Brief document to a Bam task.',
    input: {
      document_id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
      task_id: z.string().describe('Bam task UUID or human ref (e.g. FRND-42)'),
      link_type: z.enum(['reference', 'spec', 'notes', 'postmortem']).optional().describe('Type of link (default reference)'),
    },
    returns: z.object({ document_id: z.string().uuid(), task_id: z.string().uuid(), link_type: z.string() }).passthrough(),
    handler: async ({ document_id, task_id, link_type }) => {
      const resolved = await resolveDocumentId(client, document_id);
      if (!resolved) return documentNotFound(document_id);

      // Accept either a UUID or a human ref like "FRND-42". The resolver
      // hits /tasks/by-ref/:ref which enforces project-membership auth, so
      // this cannot leak tasks the caller can't already see.
      const taskId = await resolveTaskId(api, task_id);
      if (!taskId) {
        return {
          content: [
            { type: 'text' as const, text: `Task not found: ${task_id}` },
          ],
          isError: true as const,
        };
      }

      const body: Record<string, unknown> = { task_id: taskId };
      if (link_type !== undefined) body.link_type = link_type;
      const result = await client.request('POST', `/documents/${resolved}/links/task`, body);
      return result.ok ? ok(result.data) : err('linking document to task', result.data);
    },
  });

  // ===== DOCUMENTS — additional reads & lifecycle =====

  registerTool(server, {
    name: 'brief_recent',
    description: 'List recently updated Brief documents the caller can see.',
    input: {
      limit: z.number().int().positive().max(50).optional().describe('Max results (default 20, max 50)'),
    },
    returns: z.object({ data: z.array(docShape) }),
    handler: async (params) => {
      const result = await client.request('GET', `/documents/recent${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing recent documents', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_starred',
    description: "List the calling user's starred Brief documents.",
    input: {},
    returns: z.object({ data: z.array(docShape) }),
    handler: async () => {
      const result = await client.request('GET', '/documents/starred');
      return result.ok ? ok(result.data) : err('listing starred documents', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_stats',
    description: 'Get org-wide Brief document statistics (counts by status, totals, etc.).',
    input: {},
    returns: z.object({ data: z.object({}).passthrough() }).passthrough(),
    handler: async () => {
      const result = await client.request('GET', '/documents/stats');
      return result.ok ? ok(result.data) : err('getting document stats', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_semantic_search',
    description: 'Semantic (vector) search over Brief documents. Falls back to full-text search when the vector index is unavailable.',
    input: {
      q: z.string().min(1).max(500).describe('Search query text (max 500 chars)'),
      limit: z.number().int().positive().max(50).optional().describe('Max results (default 20, max 50)'),
    },
    returns: z.object({ data: z.array(z.object({}).passthrough()), meta: z.object({}).passthrough().optional() }),
    handler: async (params) => {
      const result = await client.request('GET', `/documents/semantic-search${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('semantic-searching documents', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_star',
    description: "Toggle the calling user's star on a Brief document.",
    input: {
      id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
    },
    returns: z.object({ starred: z.boolean() }).passthrough(),
    handler: async ({ id }) => {
      const documentId = await resolveDocumentId(client, id);
      if (!documentId) return documentNotFound(id);
      const result = await client.request('POST', `/documents/${documentId}/star`);
      return result.ok ? ok(result.data) : err('toggling document star', result.data);
    },
  });

  // ===== EXPORT (non-binary) =====

  registerTool(server, {
    name: 'brief_export_markdown',
    description: 'Export a Brief document as Markdown text.',
    input: {
      id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
    },
    returns: z.object({ content: z.string() }),
    handler: async ({ id }) => {
      const documentId = await resolveDocumentId(client, id);
      if (!documentId) return documentNotFound(id);
      const result = await client.request('GET', `/documents/${documentId}/export/markdown`);
      // The export endpoints return raw text/markdown, not a JSON envelope.
      return result.ok ? ok({ content: result.data }) : err('exporting document as markdown', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_export_html',
    description: 'Export a Brief document as a standalone styled HTML page.',
    input: {
      id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
    },
    returns: z.object({ content: z.string() }),
    handler: async ({ id }) => {
      const documentId = await resolveDocumentId(client, id);
      if (!documentId) return documentNotFound(id);
      const result = await client.request('GET', `/documents/${documentId}/export/html`);
      // The export endpoints return raw text/html, not a JSON envelope.
      return result.ok ? ok({ content: result.data }) : err('exporting document as html', result.data);
    },
  });

  // ===== COMMENTS — additional (edit / delete / reactions) =====

  registerTool(server, {
    name: 'brief_comment_edit',
    description: 'Edit the body of an existing Brief comment.',
    input: {
      comment_id: z.string().uuid().describe('Comment ID'),
      body: z.string().min(1).max(50_000).describe('New comment body text (1-50k chars)'),
    },
    returns: briefCommentShape,
    handler: async ({ comment_id, body }) => {
      const result = await client.request('PATCH', `/comments/${comment_id}`, { body });
      return result.ok ? ok(result.data) : err('editing comment', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_comment_delete',
    description: 'Delete a Brief comment. The author may delete their own comment; org admins/owners may delete any comment.',
    input: {
      comment_id: z.string().uuid().describe('Comment ID'),
    },
    returns: z.object({}).passthrough(),
    handler: async ({ comment_id }) => {
      const result = await client.request('DELETE', `/comments/${comment_id}`);
      return result.ok ? ok(result.data) : err('deleting comment', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_comment_react',
    description: 'Add an emoji reaction to a Brief comment.',
    input: {
      comment_id: z.string().uuid().describe('Comment ID'),
      emoji: z.string().min(1).max(32).describe('Emoji (1-32 chars)'),
    },
    returns: z.object({}).passthrough(),
    handler: async ({ comment_id, emoji }) => {
      const result = await client.request('POST', `/comments/${comment_id}/reactions`, { emoji });
      return result.ok ? ok(result.data) : err('adding comment reaction', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_comment_unreact',
    description: "Remove the calling user's emoji reaction from a Brief comment.",
    input: {
      comment_id: z.string().uuid().describe('Comment ID'),
      emoji: z.string().min(1).max(32).describe('Emoji to remove (1-32 chars)'),
    },
    returns: z.object({}).passthrough(),
    handler: async ({ comment_id, emoji }) => {
      const result = await client.request(
        'DELETE',
        `/comments/${comment_id}/reactions/${encodeURIComponent(emoji)}`,
      );
      return result.ok ? ok(result.data) : err('removing comment reaction', result.data);
    },
  });

  // ===== VERSIONS — additional (create snapshot / diff) =====

  registerTool(server, {
    name: 'brief_version_create',
    description: 'Create a named version snapshot of a Brief document at its current state.',
    input: {
      document_id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
      title: z.string().min(1).max(512).optional().describe('Snapshot label (max 512 chars)'),
      change_summary: z.string().max(1000).optional().describe('What changed since the last version (max 1000 chars)'),
    },
    returns: versionShape,
    handler: async ({ document_id, ...body }) => {
      const resolved = await resolveDocumentId(client, document_id);
      if (!resolved) return documentNotFound(document_id);
      const result = await client.request('POST', `/documents/${resolved}/versions`, body);
      return result.ok ? ok(result.data) : err('creating version snapshot', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_version_diff',
    description: 'Compute a line-by-line diff between two versions of a Brief document.',
    input: {
      document_id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
      version_id_1: z.string().uuid().describe('First (older) version ID'),
      version_id_2: z.string().uuid().describe('Second (newer) version ID'),
    },
    returns: z.object({ data: z.object({}).passthrough() }),
    handler: async ({ document_id, version_id_1, version_id_2 }) => {
      const resolved = await resolveDocumentId(client, document_id);
      if (!resolved) return documentNotFound(document_id);
      const result = await client.request(
        'GET',
        `/documents/${resolved}/versions/${version_id_1}/diff/${version_id_2}`,
      );
      return result.ok ? ok(result.data) : err('diffing versions', result.data);
    },
  });

  // ===== LINKS — additional (list / beacon link / remove) =====

  registerTool(server, {
    name: 'brief_links_list',
    description: 'List all task and Beacon links attached to a Brief document.',
    input: {
      document_id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
    },
    returns: z.object({ data: z.array(z.object({}).passthrough()) }),
    handler: async ({ document_id }) => {
      const resolved = await resolveDocumentId(client, document_id);
      if (!resolved) return documentNotFound(document_id);
      const result = await client.request('GET', `/documents/${resolved}/links`);
      return result.ok ? ok(result.data) : err('listing document links', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_link_beacon',
    description: 'Link a Brief document to a Beacon knowledge article.',
    input: {
      document_id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
      beacon_id: z.string().uuid().describe('Beacon article UUID'),
      link_type: z.enum(['reference', 'source', 'related']).optional().describe('Type of link (default reference)'),
    },
    returns: z.object({}).passthrough(),
    handler: async ({ document_id, beacon_id, link_type }) => {
      const resolved = await resolveDocumentId(client, document_id);
      if (!resolved) return documentNotFound(document_id);
      const body: Record<string, unknown> = { beacon_id };
      if (link_type !== undefined) body.link_type = link_type;
      const result = await client.request('POST', `/documents/${resolved}/links/beacon`, body);
      return result.ok ? ok(result.data) : err('linking document to beacon', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_link_remove',
    description: 'Remove a link (task or Beacon) from a Brief document. Get the link ID from brief_links_list.',
    input: {
      document_id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
      link_id: z.string().uuid().describe('Link UUID to remove'),
    },
    returns: z.object({}).passthrough(),
    handler: async ({ document_id, link_id }) => {
      const resolved = await resolveDocumentId(client, document_id);
      if (!resolved) return documentNotFound(document_id);
      // DELETE /links/:linkId requires the document_id as a query param so the
      // service can verify org ownership of the parent document.
      const result = await client.request(
        'DELETE',
        `/links/${link_id}${buildQs({ document_id: resolved })}`,
      );
      return result.ok ? ok(result.data) : err('removing document link', result.data);
    },
  });

  // ===== COLLABORATORS (list / add / update / remove) =====

  registerTool(server, {
    name: 'brief_collaborators_list',
    description: 'List the per-user collaborators (and their permissions) on a Brief document.',
    input: {
      document_id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
    },
    returns: z.object({ data: z.array(z.object({}).passthrough()) }),
    handler: async ({ document_id }) => {
      const resolved = await resolveDocumentId(client, document_id);
      if (!resolved) return documentNotFound(document_id);
      const result = await client.request('GET', `/documents/${resolved}/collaborators`);
      return result.ok ? ok(result.data) : err('listing collaborators', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_collaborator_add',
    description: 'Add a user as a collaborator on a Brief document with a given permission level.',
    input: {
      document_id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
      user_id: z.string().uuid().describe('Collaborator user UUID'),
      permission: z.enum(['view', 'comment', 'edit']).optional().describe('Permission level (default view)'),
    },
    returns: z.object({}).passthrough(),
    handler: async ({ document_id, user_id, permission }) => {
      const resolved = await resolveDocumentId(client, document_id);
      if (!resolved) return documentNotFound(document_id);
      const body: Record<string, unknown> = { user_id };
      if (permission !== undefined) body.permission = permission;
      const result = await client.request('POST', `/documents/${resolved}/collaborators`, body);
      return result.ok ? ok(result.data) : err('adding collaborator', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_collaborator_update',
    description: "Update an existing collaborator's permission level on a Brief document. Get the collaborator ID from brief_collaborators_list.",
    input: {
      collaborator_id: z.string().uuid().describe('Collaborator record UUID'),
      permission: z.enum(['view', 'comment', 'edit']).describe('New permission level'),
    },
    returns: z.object({}).passthrough(),
    handler: async ({ collaborator_id, permission }) => {
      const result = await client.request('PATCH', `/collaborators/${collaborator_id}`, { permission });
      return result.ok ? ok(result.data) : err('updating collaborator', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_collaborator_remove',
    description: 'Remove a collaborator from a Brief document. Get the collaborator ID from brief_collaborators_list.',
    input: {
      collaborator_id: z.string().uuid().describe('Collaborator record UUID'),
    },
    returns: z.object({}).passthrough(),
    handler: async ({ collaborator_id }) => {
      const result = await client.request('DELETE', `/collaborators/${collaborator_id}`);
      return result.ok ? ok(result.data) : err('removing collaborator', result.data);
    },
  });

  // ===== EMBEDS (list / delete) — upload-metadata POST is intentionally omitted =====

  registerTool(server, {
    name: 'brief_embeds_list',
    description: 'List the embedded files/images recorded on a Brief document.',
    input: {
      document_id: z.string().describe('Document ID (UUID), slug, or title (exact case-insensitive match)'),
    },
    returns: z.object({ data: z.array(z.object({}).passthrough()) }),
    handler: async ({ document_id }) => {
      const resolved = await resolveDocumentId(client, document_id);
      if (!resolved) return documentNotFound(document_id);
      const result = await client.request('GET', `/documents/${resolved}/embeds`);
      return result.ok ? ok(result.data) : err('listing embeds', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_embed_delete',
    description: 'Delete an embed (uploaded file/image) record from a Brief document. Get the embed ID from brief_embeds_list.',
    input: {
      embed_id: z.string().uuid().describe('Embed record UUID'),
    },
    returns: z.object({}).passthrough(),
    handler: async ({ embed_id }) => {
      const result = await client.request('DELETE', `/embeds/${embed_id}`);
      return result.ok ? ok(result.data) : err('deleting embed', result.data);
    },
  });

  // ===== TEMPLATES (list / create / update / delete) =====

  registerTool(server, {
    name: 'brief_templates_list',
    description: 'List the available Brief document templates (system + org).',
    input: {},
    returns: z.object({ data: z.array(z.object({}).passthrough()) }),
    handler: async () => {
      const result = await client.request('GET', '/templates');
      return result.ok ? ok(result.data) : err('listing templates', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_template_create',
    description: 'Create an organization-level Brief document template.',
    input: {
      name: z.string().min(1).max(255).describe('Template name (1-255 chars)'),
      description: z.string().max(2000).optional().describe('Template description (max 2000 chars)'),
      icon: z.string().max(100).optional().describe('Template icon (emoji or icon name)'),
      category: z.string().max(100).optional().describe('Template category'),
      html_preview: z.string().max(5_000_000).optional().describe('Template body / preview HTML'),
      sort_order: z.number().int().optional().describe('Sort order within the template list'),
    },
    returns: z.object({}).passthrough(),
    handler: async (params) => {
      const result = await client.request('POST', '/templates', params);
      return result.ok ? ok(result.data) : err('creating template', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_template_update',
    description: 'Update an organization Brief document template. Provide only the fields to change.',
    input: {
      id: z.string().uuid().describe('Template UUID'),
      name: z.string().min(1).max(255).optional().describe('Updated name'),
      description: z.string().max(2000).optional().describe('Updated description'),
      icon: z.string().max(100).optional().describe('Updated icon'),
      category: z.string().max(100).optional().describe('Updated category'),
      html_preview: z.string().max(5_000_000).optional().describe('Updated body / preview HTML'),
      sort_order: z.number().int().optional().describe('Updated sort order'),
    },
    returns: z.object({}).passthrough(),
    handler: async ({ id, ...body }) => {
      const result = await client.request('PATCH', `/templates/${id}`, body);
      return result.ok ? ok(result.data) : err('updating template', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_template_delete',
    description: 'Delete an organization Brief document template.',
    input: {
      id: z.string().uuid().describe('Template UUID'),
    },
    returns: z.object({}).passthrough(),
    handler: async ({ id }) => {
      const result = await client.request('DELETE', `/templates/${id}`);
      return result.ok ? ok(result.data) : err('deleting template', result.data);
    },
  });

  // ===== FOLDERS (list / create / update / delete) =====

  registerTool(server, {
    name: 'brief_folders_list',
    description: 'List the Brief folder tree for the org, optionally scoped to a project.',
    input: {
      project_id: z.string().uuid().optional().describe('Filter folders to a specific project'),
    },
    returns: z.object({ data: z.array(z.object({}).passthrough()) }),
    handler: async (params) => {
      const result = await client.request('GET', `/folders${buildQs(params)}`);
      return result.ok ? ok(result.data) : err('listing folders', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_folder_create',
    description: 'Create a Brief folder, optionally nested under a parent folder and/or scoped to a project.',
    input: {
      name: z.string().min(1).max(255).describe('Folder name (1-255 chars)'),
      project_id: z.string().uuid().optional().describe('Project to scope the folder to'),
      parent_id: z.string().uuid().optional().describe('Parent folder UUID (for nesting)'),
      sort_order: z.number().int().optional().describe('Sort order among siblings'),
    },
    returns: z.object({}).passthrough(),
    handler: async (params) => {
      const result = await client.request('POST', '/folders', params);
      return result.ok ? ok(result.data) : err('creating folder', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_folder_update',
    description: 'Update or move a Brief folder. Provide only the fields to change.',
    input: {
      id: z.string().uuid().describe('Folder UUID'),
      name: z.string().min(1).max(255).optional().describe('Updated name'),
      parent_id: z.string().uuid().nullable().optional().describe('Move under a different parent folder (null to move to root)'),
      sort_order: z.number().int().optional().describe('Updated sort order'),
    },
    returns: z.object({}).passthrough(),
    handler: async ({ id, ...body }) => {
      const result = await client.request('PATCH', `/folders/${id}`, body);
      return result.ok ? ok(result.data) : err('updating folder', result.data);
    },
  });

  registerTool(server, {
    name: 'brief_folder_delete',
    description: 'Delete a Brief folder.',
    input: {
      id: z.string().uuid().describe('Folder UUID'),
    },
    returns: z.object({}).passthrough(),
    handler: async ({ id }) => {
      const result = await client.request('DELETE', `/folders/${id}`);
      return result.ok ? ok(result.data) : err('deleting folder', result.data);
    },
  });
}
