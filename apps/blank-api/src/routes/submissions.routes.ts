import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../plugins/auth.js';
import * as submissionService from '../services/submission.service.js';
import { getFileStream } from '../lib/storage.js';

interface ProcessedFileEntry {
  filename?: string;
  storage_key?: string | null;
  content_type?: string | null;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export default async function submissionRoutes(fastify: FastifyInstance) {
  // GET /forms/:id/submissions — List submissions
  fastify.get<{ Params: { id: string } }>(
    '/forms/:id/submissions',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const query = request.query as Record<string, string>;
      const result = await submissionService.listSubmissions(
        request.params.id,
        request.user!.org_id,
        {
          cursor: query.cursor,
          limit: query.limit ? parseInt(query.limit, 10) : undefined,
          file_processing_status:
            query['filter[file_processing_status]'] ?? query.file_processing_status,
        },
      );
      return reply.send({ data: result.data, meta: { next_cursor: result.next_cursor, has_more: result.has_more } });
    },
  );

  // GET /submissions/:id — Get submission detail
  fastify.get<{ Params: { id: string } }>(
    '/submissions/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const submission = await submissionService.getSubmission(request.params.id, request.user!.org_id);
      return reply.send({ data: submission });
    },
  );

  // GET /submissions/:id/files/:idx — Stream a stored submission attachment.
  // Org-scoped (the submission lookup enforces request.user.org_id), so only
  // members of the owning org can download files. The :idx indexes into the
  // worker-populated processed_files.files array.
  fastify.get<{ Params: { id: string; idx: string } }>(
    '/submissions/:id/files/:idx',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const submission = await submissionService.getSubmission(
        request.params.id,
        request.user!.org_id,
      );

      const processed = (submission.processed_files ?? {}) as { files?: ProcessedFileEntry[] };
      const files = Array.isArray(processed.files) ? processed.files : [];
      const idx = Number.parseInt(request.params.idx, 10);
      const entry = Number.isInteger(idx) ? files[idx] : undefined;

      if (!entry || !entry.storage_key) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'File not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      try {
        const { stream, contentType, size } = await getFileStream(entry.storage_key);
        reply.header('Content-Type', entry.content_type ?? contentType);
        reply.header('Content-Length', size);
        reply.header(
          'Content-Disposition',
          `inline; filename="${(entry.filename ?? 'download').replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
        );
        reply.header('Cache-Control', 'private, max-age=3600');
        return reply.send(stream);
      } catch {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'File not found',
            details: [],
            request_id: request.id,
          },
        });
      }
    },
  );

  // DELETE /submissions/:id — Delete a submission
  fastify.delete<{ Params: { id: string } }>(
    '/submissions/:id',
    { preHandler: [requireAuth, fastify.requireCan('blank.submission.delete')] },
    async (request, reply) => {
      await submissionService.deleteSubmission(request.params.id, request.user!.org_id);
      return reply.send({ data: { deleted: true } });
    },
  );

  // GET /forms/:id/submissions/export — Export as CSV
  fastify.get<{ Params: { id: string } }>(
    '/forms/:id/submissions/export',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const csv = await submissionService.exportSubmissions(
        request.params.id,
        request.user!.org_id,
      );
      reply
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', 'attachment; filename="submissions.csv"')
        .send(csv);
    },
  );

  // GET /forms/:id/analytics — Response aggregation
  fastify.get<{ Params: { id: string } }>(
    '/forms/:id/analytics',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const analytics = await submissionService.getFormAnalytics(
        request.params.id,
        request.user!.org_id,
      );
      return reply.send({ data: analytics });
    },
  );
}
