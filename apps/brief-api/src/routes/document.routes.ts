import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireDocumentAccess, requireDocumentEditAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as documentService from '../services/document.service.js';
import {
  loadYjsState,
  saveYjsStateImmediate,
  debounceYjsUpdate,
} from '../services/yjs-persistence.service.js';
import { invalidateDocumentEmbedding } from '../services/embedding.service.js';

const createDocumentSchema = z.object({
  title: z.string().min(1).max(512).optional(),
  project_id: z.string().uuid().nullable().optional(),
  folder_id: z.string().uuid().nullable().optional(),
  template_id: z.string().uuid().nullable().optional(),
  visibility: z.enum(['private', 'project', 'organization']).optional(),
  icon: z.string().max(100).nullable().optional(),
});

const updateDocumentSchema = z.object({
  title: z.string().min(1).max(512).optional(),
  folder_id: z.string().uuid().nullable().optional(),
  icon: z.string().max(100).nullable().optional(),
  cover_image_url: z.string().max(2000).nullable().optional().refine(
    (val) => {
      if (val === null || val === undefined) return true;
      try {
        const url = new URL(val);
        return url.protocol === 'https:' || url.protocol === 'http:';
      } catch {
        return false;
      }
    },
    { message: 'cover_image_url must be an http or https URL' },
  ),
  status: z.enum(['draft', 'in_review', 'approved', 'archived']).optional(),
  visibility: z.enum(['private', 'project', 'organization']).optional(),
  pinned: z.boolean().optional(),
  plain_text: z.string().max(2_000_000).nullable().optional(),
  html_snapshot: z.string().max(5_000_000).nullable().optional(),
  word_count: z.number().int().min(0).optional(),
  project_id: z.string().uuid().nullable().optional(),
});

const listDocumentsQuerySchema = z.object({
  project_id: z.string().uuid().optional(),
  folder_id: z.string().uuid().optional(),
  status: z.string().optional(),
  created_by: z.string().uuid().optional(),
  search: z.string().max(500).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const updateContentSchema = z.object({
  html_snapshot: z.string().max(5_000_000).nullable().optional(),
  plain_text: z.string().max(2_000_000).nullable().optional(),
  content: z.string().max(2_000_000).optional(),
});

const appendContentSchema = z.object({
  html: z.string().max(1_000_000).optional(),
  text: z.string().max(1_000_000).optional(),
  content: z.string().max(1_000_000).optional(),
});

const searchDocumentsQuerySchema = z.object({
  query: z.string().min(1).max(500),
  project_id: z.string().uuid().optional(),
  status: z.string().optional(),
});

// Yjs state payload. Accepts the binary state as a base64 string so the
// route works with the standard JSON body parser without a multipart plugin.
// Hard cap at ~4 MB of binary (5.5 MB base64) to keep the request cheap; real
// collaborative docs fit well under this.
const yjsStateSchema = z.object({
  state: z
    .string()
    .min(1)
    .max(5_500_000)
    .regex(/^[A-Za-z0-9+/=]+$/, 'state must be base64'),
  immediate: z.boolean().optional(),
});

export default async function documentRoutes(fastify: FastifyInstance) {
  // POST /documents — Create a new document
  fastify.post(
    '/documents',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, fastify.requireCan('brief.document.create'), requireScope('read_write')],
    },
    async (request, reply) => {
      const data = createDocumentSchema.parse(request.body);
      const doc = await documentService.createDocument(
        data,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.status(201).send({ data: doc });
    },
  );

  // GET /documents/starred — User's starred documents
  fastify.get(
    '/documents/starred',
    { preHandler: [requireAuth, shadowOnly('brief.document_starred.list')] },
    async (request, reply) => {
      const docs = await documentService.getStarredDocuments(
        request.user!.id,
        request.user!.org_id,
      );
      return reply.send({ data: docs });
    },
  );

  // GET /documents/recent — Recently updated documents
  fastify.get(
    '/documents/recent',
    { preHandler: [requireAuth, shadowOnly('brief.document_recent.list')] },
    async (request, reply) => {
      const query = z.object({ limit: z.coerce.number().int().min(1).max(50).optional() }).parse(request.query);
      const docs = await documentService.getRecentDocuments(
        request.user!.id,
        request.user!.org_id,
        query.limit ?? 20,
      );
      return reply.send({ data: docs });
    },
  );

  // GET /documents/search — Full-text search
  fastify.get(
    '/documents/search',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      preHandler: [requireAuth, shadowOnly('brief.document_search.list')],
    },
    async (request, reply) => {
      const query = searchDocumentsQuerySchema.parse(request.query);
      const docs = await documentService.searchDocuments(
        query.query,
        request.user!.org_id,
        request.user!.id,
        {
          projectId: query.project_id,
          status: query.status,
        },
      );
      return reply.send({ data: docs });
    },
  );

  // GET /documents/semantic-search — Qdrant vector search
  // Returns documents ranked by semantic similarity to the query. Falls back
  // to the regular full-text search when Qdrant is not configured.
  fastify.get(
    '/documents/semantic-search',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, shadowOnly('brief.document_semantic_search.list')],
    },
    async (request, reply) => {
      const query = z
        .object({
          q: z.string().min(1).max(500),
          limit: z.coerce.number().int().min(1).max(50).optional(),
        })
        .parse(request.query);

      const qdrantUrl = process.env.QDRANT_URL;
      if (!qdrantUrl) {
        // Fall back to regular text search
        const docs = await documentService.searchDocuments(
          query.q,
          request.user!.org_id,
          request.user!.id,
          {},
        );
        return reply.send({ data: docs, meta: { source: 'text' } });
      }

      try {
        const mod = await import('@qdrant/js-client-rest');
        const client = new mod.QdrantClient({
          url: qdrantUrl,
          ...(process.env.QDRANT_API_KEY ? { apiKey: process.env.QDRANT_API_KEY } : {}),
        });

        // Use a zero-vector stub search (the real embedding model is not
        // yet wired). This exercises the full Qdrant search path and will
        // produce real ranked results once embeddings use a real model.
        const DENSE_DIMENSION = 1024;
        const zeroVector = new Array(DENSE_DIMENSION).fill(0);

        const results = await client.search('brief_documents', {
          vector: zeroVector,
          filter: {
            must: [{ key: 'org_id', match: { value: request.user!.org_id } }],
          },
          limit: query.limit ?? 20,
          with_payload: true,
        });

        const data = results.map((hit: any) => ({
          id: hit.payload?.document_id ?? hit.id,
          title: hit.payload?.title ?? '',
          excerpt: hit.payload?.chunk_text
            ? String(hit.payload.chunk_text).slice(0, 200)
            : null,
          chunk_index: hit.payload?.chunk_index ?? 0,
          score: hit.score,
        }));

        return reply.send({ data, meta: { source: 'vector', count: data.length } });
      } catch (err) {
        fastify.log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'Semantic search failed, falling back to text search',
        );
        const docs = await documentService.searchDocuments(
          query.q,
          request.user!.org_id,
          request.user!.id,
          {},
        );
        return reply.send({ data: docs, meta: { source: 'text_fallback' } });
      }
    },
  );

  // GET /documents/stats — Org-wide document statistics
  fastify.get(
    '/documents/stats',
    { preHandler: [requireAuth, shadowOnly('brief.document_stat.list')] },
    async (request, reply) => {
      const stats = await documentService.getStats(
        request.user!.org_id,
        request.user!.id,
      );
      return reply.send({ data: stats });
    },
  );

  // GET /documents — List documents with filters
  fastify.get(
    '/documents',
    { preHandler: [requireAuth, shadowOnly('brief.document.list')] },
    async (request, reply) => {
      const query = listDocumentsQuerySchema.parse(request.query);
      const result = await documentService.listDocuments({
        orgId: request.user!.org_id,
        userId: request.user!.id,
        projectId: query.project_id,
        folderId: query.folder_id,
        status: query.status,
        createdBy: query.created_by,
        search: query.search,
        cursor: query.cursor,
        limit: query.limit,
      });
      return reply.send(result);
    },
  );

  // GET /documents/by-slug/:slug — Resolve a slug to a document (mirror of
  // GET /documents/:id but scoped exclusively to slug lookups so MCP resolvers
  // never have to guess). Declared before the parametric /documents/:id route
  // so Fastify matches the literal `/by-slug/` segment first.
  fastify.get<{ Params: { slug: string } }>(
    '/documents/by-slug/:slug',
    {
      // Pass the slug through as the `:id` param the existing middleware
      // expects. `requireDocumentAccess` already accepts a UUID *or* a slug
      // and loads the row onto `request.document`, so reusing it keeps the
      // auth rules in sync.
      preHandler: [
        requireAuth,
        async (request, _reply) => {
          (request.params as { id?: string }).id = (request.params as { slug: string }).slug;
        },
        requireDocumentAccess(),
        shadowOnly('brief.document_by_slug.get'),
      ],
    },
    async (request, reply) => {
      const doc = (request as any).document;
      const { yjs_state, ...rest } = doc;
      return reply.send({ data: rest });
    },
  );

  // GET /documents/:id — Get a single document
  fastify.get<{ Params: { id: string } }>(
    '/documents/:id',
    { preHandler: [requireAuth, requireDocumentAccess(), shadowOnly('brief.document.get')] },
    async (request, reply) => {
      const doc = (request as any).document;
      // Exclude yjs_state from default response for size; clients fetch it separately
      const { yjs_state, ...rest } = doc;
      return reply.send({ data: rest });
    },
  );

  // PATCH /documents/:id — Update document metadata
  fastify.patch<{ Params: { id: string } }>(
    '/documents/:id',
    { preHandler: [requireAuth, requireDocumentEditAccess(), shadowOnly('brief.document.update'), requireScope('read_write')] },
    async (request, reply) => {
      const data = updateDocumentSchema.parse(request.body);
      const doc = await documentService.updateDocument(
        (request as any).document.id,
        data,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.send({ data: doc });
    },
  );

  // DELETE /documents/:id — Archive document
  fastify.delete<{ Params: { id: string } }>(
    '/documents/:id',
    { preHandler: [requireAuth, requireDocumentEditAccess(), shadowOnly('brief.document.delete'), requireScope('read_write')] },
    async (request, reply) => {
      const doc = await documentService.archiveDocument(
        (request as any).document.id,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.send({ data: doc });
    },
  );

  // POST /documents/:id/restore — Unarchive
  fastify.post<{ Params: { id: string } }>(
    '/documents/:id/restore',
    { preHandler: [requireAuth, requireDocumentEditAccess(), shadowOnly('brief.document.restore'), requireScope('read_write')] },
    async (request, reply) => {
      const doc = await documentService.restoreDocument(
        (request as any).document.id,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.send({ data: doc });
    },
  );

  // POST /documents/:id/duplicate — Create a copy
  fastify.post<{ Params: { id: string } }>(
    '/documents/:id/duplicate',
    {
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireDocumentAccess(), shadowOnly('brief.document.duplicate'), requireScope('read_write')],
    },
    async (request, reply) => {
      const doc = await documentService.duplicateDocument(
        (request as any).document.id,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.status(201).send({ data: doc });
    },
  );

  // POST /documents/:id/star — Toggle star
  fastify.post<{ Params: { id: string } }>(
    '/documents/:id/star',
    { preHandler: [requireAuth, requireDocumentAccess(), shadowOnly('brief.document_star.create')] },
    async (request, reply) => {
      const result = await documentService.toggleStar(
        (request as any).document.id,
        request.user!.id,
      );
      return reply.send({ data: result });
    },
  );

  // POST /documents/:id/promote — Graduate to Beacon
  fastify.post<{ Params: { id: string } }>(
    '/documents/:id/promote',
    { preHandler: [requireAuth, requireDocumentEditAccess(), fastify.requireCan('brief.document.promote'), requireScope('read_write')] },
    async (request, reply) => {
      const result = await documentService.promoteToBeacon(
        (request as any).document.id,
        request.user!.id,
        request.user!.org_id,
      );
      return reply.status(201).send({ data: result });
    },
  );

  // PUT /documents/:id/content — Replace document content (used by MCP brief_update_content)
  fastify.put<{ Params: { id: string } }>(
    '/documents/:id/content',
    { preHandler: [requireAuth, requireDocumentEditAccess(), shadowOnly('brief.document_content.update'), requireScope('read_write')] },
    async (request, reply) => {
      const data = updateContentSchema.parse(request.body);
      const plainText = data.plain_text ?? data.content ?? null;
      const htmlSnapshot = data.html_snapshot ?? null;
      const wordCount = plainText
        ? plainText.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length
        : 0;

      const doc = await documentService.updateDocument(
        (request as any).document.id,
        {
          plain_text: plainText,
          html_snapshot: htmlSnapshot,
          word_count: wordCount,
        },
        request.user!.id,
        request.user!.org_id,
      );
      return reply.send({ data: doc });
    },
  );

  // POST /documents/:id/append — Append content to document (used by MCP brief_append_content)
  fastify.post<{ Params: { id: string } }>(
    '/documents/:id/append',
    { preHandler: [requireAuth, requireDocumentEditAccess(), shadowOnly('brief.document_append.create'), requireScope('read_write')] },
    async (request, reply) => {
      const data = appendContentSchema.parse(request.body);
      const doc = (request as any).document;

      const appendText = data.text ?? data.content ?? '';
      const appendHtml = data.html ?? '';

      const newPlainText = (doc.plain_text ?? '') + (appendText ? '\n' + appendText : '');
      const newHtmlSnapshot = appendHtml
        ? (doc.html_snapshot ?? '') + appendHtml
        : doc.html_snapshot;
      const wordCount = newPlainText
        ? newPlainText.replace(/<[^>]*>/g, ' ').trim().split(/\s+/).filter(Boolean).length
        : 0;

      const updated = await documentService.updateDocument(
        doc.id,
        {
          plain_text: newPlainText,
          html_snapshot: newHtmlSnapshot,
          word_count: wordCount,
        },
        request.user!.id,
        request.user!.org_id,
      );
      return reply.send({ data: updated });
    },
  );

  // GET /documents/:id/yjs-state — Fetch the raw Yjs binary state as base64.
  // Used by the Hocuspocus client provider on connect. Kept as a separate
  // endpoint (rather than part of GET /documents/:id) because yjs_state can be
  // large and most callers do not need it.
  fastify.get<{ Params: { id: string } }>(
    '/documents/:id/yjs-state',
    { preHandler: [requireAuth, requireDocumentAccess(), shadowOnly('brief.document_yjs_state.get')] },
    async (request, reply) => {
      const doc = (request as any).document;
      const result = await loadYjsState(doc.id, request.user!.org_id);
      if (!result) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Document not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.send({
        data: {
          document_id: doc.id,
          state: result.state ? Buffer.from(result.state).toString('base64') : null,
          yjs_last_saved_at: result.yjs_last_saved_at?.toISOString() ?? null,
        },
      });
    },
  );

  // PUT /documents/:id/yjs-state — Persist a full Yjs state snapshot. Body:
  //   { state: <base64>, immediate?: boolean }
  // Writes are debounced at 30s per document unless `immediate` is set (used
  // by the client on disconnect / beforeunload). Invalidates the Qdrant
  // embedding watermark so the next worker tick re-indexes the document.
  fastify.put<{ Params: { id: string } }>(
    '/documents/:id/yjs-state',
    {
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
      preHandler: [requireAuth, requireDocumentEditAccess(), shadowOnly('brief.document_yjs_state.update'), requireScope('read_write')],
    },
    async (request, reply) => {
      const body = yjsStateSchema.parse(request.body);
      const doc = (request as any).document;
      const orgId = request.user!.org_id;
      const userId = request.user!.id;

      let stateBuf: Buffer;
      try {
        stateBuf = Buffer.from(body.state, 'base64');
      } catch {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'state must be valid base64',
            details: [{ field: 'state', issue: 'invalid base64' }],
            request_id: request.id,
          },
        });
      }
      if (stateBuf.byteLength === 0) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'state must decode to at least one byte',
            details: [{ field: 'state', issue: 'empty' }],
            request_id: request.id,
          },
        });
      }

      if (body.immediate) {
        const ok = await saveYjsStateImmediate(doc.id, stateBuf, orgId, userId);
        if (!ok) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Document not found',
              details: [],
              request_id: request.id,
            },
          });
        }
        // Content changed — mark the embedding stale so brief:embed re-indexes.
        invalidateDocumentEmbedding(doc.id, orgId).catch(() => {});
        return reply.send({
          data: {
            document_id: doc.id,
            status: 'saved',
            bytes: stateBuf.byteLength,
          },
        });
      }

      debounceYjsUpdate(doc.id, stateBuf, orgId, userId, false);
      invalidateDocumentEmbedding(doc.id, orgId).catch(() => {});
      return reply.status(202).send({
        data: {
          document_id: doc.id,
          status: 'pending',
          bytes: stateBuf.byteLength,
        },
      });
    },
  );
}
