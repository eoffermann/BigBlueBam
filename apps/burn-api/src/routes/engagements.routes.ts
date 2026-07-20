import type { FastifyInstance } from 'fastify';
import {
  burnEngagementCreateRefined,
  burnEngagementUpdateSchema,
  burnListQuerySchema,
} from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { askerViewer, mapServiceError, readViewer, validationError, viewerOf } from '../lib/http.js';
import { redactFinancialFields } from '../lib/redact-financial-fields.js';
import { enqueueExtraction } from '../lib/queue.js';
import * as engagements from '../services/engagements.service.js';

export default async function engagementRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get(
    '/engagements',
    { preHandler: [requireAuth, can('burn.engagement.read')] },
    async (request) => {
      const q = request.query as {
        cursor?: string;
        limit?: string;
        filter?: Record<string, string>;
      };
      const parsed = burnListQuerySchema.safeParse(q);
      const limit = parsed.success ? parsed.data.limit : 25;
      const result = await engagements.listEngagements(readViewer(request), {
        cursor: q.cursor,
        limit,
        status: q.filter?.status,
        accountId: q.filter?.account_id,
        chainRootId: q.filter?.chain_root_id,
      });
      // `contract_value` and `contract_value_delta` are floored keys. The serializer runs on
      // the WHOLE body, not per row, so the next field added to this response is covered
      // without anyone remembering to cover it.
      return redactFinancialFields(result, await request.viewerCaps());
    },
  );

  fastify.post(
    '/engagements',
    { preHandler: [requireAuth, can('burn.engagement.write')] },
    async (request, reply) => {
      const parsed = burnEngagementCreateRefined.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const asker = askerViewer(request);
        const viewer = viewerOf(request);
        const result = await engagements.createEngagement(viewer, parsed.data, asker?.id ?? null);
        // An engagement created WITH a source contract (bin_asset_id) kicks off extraction
        // immediately, so a user does not have to make a second /extract call. Best-effort and
        // deduped with any explicit /extract in the same window.
        if (parsed.data.bin_asset_id) {
          await enqueueExtraction({ organization_id: viewer.org_id, engagement_id: result.data.id });
        }
        reply.status(201);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.get(
    '/engagements/:id',
    { preHandler: [requireAuth, can('burn.engagement.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const result = await engagements.getEngagement(readViewer(request), id);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.patch(
    '/engagements/:id',
    { preHandler: [requireAuth, can('burn.engagement.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = burnEngagementUpdateSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        // The asker preflight layered ON TOP of the bearer guard: when an agent acts for a
        // human, the project narrowing must run against the ASKER too, not only against a
        // possibly-admin service-account bearer.
        const asker = askerViewer(request);
        if (asker) await engagements.loadScopedEngagement(asker, id);
        const result = await engagements.updateEngagement(viewerOf(request), id, parsed.data);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.delete(
    '/engagements/:id',
    { preHandler: [requireAuth, can('burn.engagement.delete')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return await engagements.deleteEngagement(viewerOf(request), id);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.post(
    '/engagements/:id/projects',
    { preHandler: [requireAuth, can('burn.engagement.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = request.body as { project_id?: string };
      if (!body?.project_id) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'project_id is required',
            details: [],
            request_id: request.id,
          },
        });
      }
      try {
        return await engagements.linkProject(viewerOf(request), id, body.project_id);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.delete(
    '/engagements/:id/projects/:projectId',
    { preHandler: [requireAuth, can('burn.engagement.write')] },
    async (request, reply) => {
      const { id, projectId } = request.params as { id: string; projectId: string };
      try {
        return await engagements.unlinkProject(viewerOf(request), id, projectId);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.post(
    '/engagements/:id/extract',
    { preHandler: [requireAuth, can('burn.engagement.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const viewer = viewerOf(request);
        await engagements.loadScopedEngagement(viewer, id);
        // Actually enqueue the extraction job. The worker's burn-extract-deliverables handler
        // reads the engagement's bin.asset bytes and POSTs the parsed text to
        // /v1/internal/run-extraction. Best-effort: a Redis hiccup does not fail the request,
        // but the response reports whether the job was accepted rather than claiming `queued`
        // when nothing ran.
        const enqueued = await enqueueExtraction({ organization_id: viewer.org_id, engagement_id: id });
        return reply.status(enqueued ? 202 : 503).send({
          data: {
            engagement_id: id,
            status: enqueued ? 'queued' : 'enqueue_failed',
            queue: 'burn-extract-deliverables',
          },
        });
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.get(
    '/engagements/:id/burndown',
    { preHandler: [requireAuth, can('burn.financials.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const caps = await request.viewerCaps();
        const result = await engagements.getBurndown(readViewer(request), id, caps);
        // EVERY burn-down point passes through the serializer. Spec 2.4 point 17 (R3-S5) is
        // explicit that the time series is the sharpest disclosure surface in the app: ten
        // daily snapshots plus the Bam per-person hour vector solve the cost-rate vector by
        // least squares. The floored keys are absent from every point, not banded.
        return redactFinancialFields(result, caps);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );
}
