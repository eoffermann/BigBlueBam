import type { FastifyInstance } from 'fastify';
import {
  bursarListQuerySchema,
  bursarRequestCreateSchema,
  bursarRequestUpdateSchema,
} from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { askerViewer, mapServiceError, validationError, viewerOf } from '../lib/http.js';
import { redactFinancialFields } from '../lib/redact-financial-fields.js';
import * as requests from '../services/requests.service.js';

// Per-route permission metadata authored inline (spec 13.3). See the note in vendors.routes.ts
// about the interim SuperUser-only posture through M8.
export default async function requestRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get(
    '/requests',
    { preHandler: [requireAuth, can('bursar.request.read')] },
    async (request) => {
      const q = request.query as { cursor?: string; limit?: string; filter?: Record<string, string> };
      const parsed = bursarListQuerySchema.safeParse(q);
      const limit = parsed.success ? parsed.data.limit : 25;
      const result = await requests.listRequests(viewerOf(request), {
        cursor: q.cursor,
        limit,
        status: q.filter?.status,
      });
      return redactFinancialFields(result, await request.viewerCaps());
    },
  );

  fastify.post(
    '/requests',
    { preHandler: [requireAuth, can('bursar.request.write')] },
    async (request, reply) => {
      const parsed = bursarRequestCreateSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        // The acting user for the §5.8 Bin access check is the asker when an agent acts for a
        // human, otherwise the bearer.
        const viewer = viewerOf(request);
        const asker = askerViewer(request);
        const result = await requests.createRequest(viewer, parsed.data, asker?.id ?? viewer.id);
        reply.status(201);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.get(
    '/requests/:id',
    { preHandler: [requireAuth, can('bursar.request.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const result = await requests.getRequest(viewerOf(request), id);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.patch(
    '/requests/:id',
    { preHandler: [requireAuth, can('bursar.request.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = bursarRequestUpdateSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const viewer = viewerOf(request);
        const asker = askerViewer(request);
        const result = await requests.updateRequest(viewer, id, parsed.data, asker?.id ?? viewer.id);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );
}
