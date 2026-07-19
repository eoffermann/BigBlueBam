import type { FastifyInstance } from 'fastify';
import { bulwarkDischargeSchema, bulwarkListQuerySchema } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { askerViewer, mapServiceError, readViewer, validationError, viewerOf } from '../lib/http.js';
import * as deadlines from '../services/deadlines.service.js';
import { draftNotice, approveAndSendNotice } from '../services/send.service.js';

export default async function deadlineRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  // The notice_draft body is surfaced ONLY to bulwark.notice.draft holders (SK2). canResolve
  // is the pure decision probe (never touches the reply), so a member-tier deadline.read
  // caller gets radar fields WITHOUT the body.
  const holdsNoticeDraft = (request: Parameters<typeof fastify.canResolve>[0]) =>
    fastify.canResolve(request, 'bulwark.notice.draft');

  fastify.get(
    '/deadlines',
    { preHandler: [requireAuth, can('bulwark.deadline.read')] },
    async (request) => {
      const q = request.query as { cursor?: string; limit?: string; filter?: Record<string, string> };
      const parsed = bulwarkListQuerySchema.safeParse(q);
      const limit = parsed.success ? parsed.data.limit : 25;
      const includeBody = await holdsNoticeDraft(request);
      return deadlines.listDeadlines(
        readViewer(request),
        {
          cursor: q.cursor,
          limit,
          status: q.filter?.status,
          contractId: q.filter?.contract_id,
          dueBefore: q.filter?.due_before,
          projectId: q.filter?.project_id,
        },
        includeBody,
      );
    },
  );

  fastify.get(
    '/deadlines/:id',
    { preHandler: [requireAuth, can('bulwark.deadline.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const includeBody = await holdsNoticeDraft(request);
        const data = await deadlines.getDeadline(readViewer(request), id, includeBody);
        return { data };
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.post(
    '/deadlines/:id/draft-notice',
    { preHandler: [requireAuth, can('bulwark.notice.draft')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const viewer = viewerOf(request);
        // Project-scope guard (SH1).
        await deadlines.loadScopedDeadline(viewer, id);
        const data = await draftNotice(viewer.org_id, id);
        return { data };
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.post(
    '/deadlines/:id/approve-send',
    { preHandler: [requireAuth, can('bulwark.notice.draft')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const viewer = viewerOf(request);
        await deadlines.loadScopedDeadline(viewer, id);
        const data = await approveAndSendNotice(viewer.org_id, id, viewer.id);
        return { data };
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.post(
    '/deadlines/:id/discharge',
    { preHandler: [requireAuth, can('bulwark.deadline.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = bulwarkDischargeSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        // Asker preflight layered on top of the bearer guard (SH1, Braid #60): fail closed
        // against the acting human, not just the admin-bearer.
        const asker = askerViewer(request);
        if (asker) await deadlines.loadScopedDeadline(asker, id);
        const data = await deadlines.dischargeDeadline(viewerOf(request), id, parsed.data);
        return { data };
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );
}
