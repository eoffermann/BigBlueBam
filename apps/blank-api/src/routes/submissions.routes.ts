import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../plugins/auth.js';
import * as submissionService from '../services/submission.service.js';

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
