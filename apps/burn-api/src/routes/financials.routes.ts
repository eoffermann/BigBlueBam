import type { FastifyInstance } from 'fastify';
import { burnCostRateCreateSchema } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import {
  mapServiceError,
  readViewer,
  requireOrgAdmin,
  validationError,
  viewerOf,
} from '../lib/http.js';
import { redactFinancialFields } from '../lib/redact-financial-fields.js';
import * as financials from '../services/financials.service.js';
import * as costRates from '../services/cost-rates.service.js';

export default async function financialRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get(
    '/financials',
    { preHandler: [requireAuth, can('burn.financials.read')] },
    async (request, reply) => {
      const q = request.query as { engagement_id?: string };
      if (!q.engagement_id) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'engagement_id is required',
            details: [],
            request_id: request.id,
          },
        });
      }
      try {
        const caps = await request.viewerCaps();
        // buildMoneyBlock returns the `suppressed` union member for a non-read_all caller.
        // That variant HAS NO cost, margin, or coverage key, so leaking one is structurally
        // impossible rather than conventionally discouraged. The serializer then runs over
        // the whole body as a second, independent layer.
        const result = await financials.getChainFinancials(readViewer(request), q.engagement_id, caps);
        return redactFinancialFields(result, caps);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.get(
    '/financials/accounts',
    // TWO INDEPENDENT GATES (spec 2.4 point 1). requireCan resolves through apps/api and
    // returns 'unknown' on any non-2xx; requireOrgAdmin reads the org role directly off
    // request.user and consults nothing else. A resolver outage therefore cannot open
    // firm-wide profitability.
    { preHandler: [requireAuth, can('burn.financials.read_all'), requireOrgAdmin] },
    async (request, reply) => {
      try {
        const caps = await request.viewerCaps();
        const result = await financials.getAccountFinancials(readViewer(request), caps);
        return redactFinancialFields(result, caps);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.get(
    '/financials/export',
    { preHandler: [requireAuth, can('burn.financials.read_all'), requireOrgAdmin] },
    async (request, reply) => {
      try {
        const caps = await request.viewerCaps();
        const csv = await financials.exportFinancialsCsv(readViewer(request), caps);
        reply.header('Content-Type', 'text/csv; charset=utf-8');
        reply.header('Content-Disposition', 'attachment; filename="burn-financials.csv"');
        return csv;
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  /* ---------------------------------------------------------------- */
  /*  Cost rates: per-person compensation                             */
  /* ---------------------------------------------------------------- */
  //
  // NOT serializer-floored, deliberately: `cost_amount` is not a field on this payload, it IS
  // the payload, and flooring it would return a list of empty objects. The protection is
  // entirely at the route -- the named permission PLUS the independent org-role guard.

  fastify.get(
    '/cost-rates',
    { preHandler: [requireAuth, can('burn.costrate.read'), requireOrgAdmin] },
    async (request) => {
      const q = request.query as { filter?: Record<string, string> };
      return costRates.listCostRates(viewerOf(request), {
        userId: q.filter?.user_id,
        projectId: q.filter?.project_id,
      });
    },
  );

  fastify.post(
    '/cost-rates',
    { preHandler: [requireAuth, can('burn.costrate.write'), requireOrgAdmin] },
    async (request, reply) => {
      const parsed = burnCostRateCreateSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        // A write enqueues burn-revalue (M6): adding a rate must revalue the EXISTING work
        // items that had none, or the card flips to "Margin" over a history still valued at
        // zero cost.
        const result = await costRates.createCostRate(viewerOf(request), parsed.data);
        reply.status(201);
        return result;
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.patch(
    '/cost-rates/:id',
    { preHandler: [requireAuth, can('burn.costrate.write'), requireOrgAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = burnCostRateCreateSchema.partial().safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        return await costRates.updateCostRate(viewerOf(request), id, parsed.data);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.delete(
    '/cost-rates/:id',
    { preHandler: [requireAuth, can('burn.costrate.write'), requireOrgAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return await costRates.deleteCostRate(viewerOf(request), id);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );
}
