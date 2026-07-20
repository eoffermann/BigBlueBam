import type { FastifyInstance } from 'fastify';
import {
  bursarAwardAmendSchema,
  bursarAwardCreateSchema,
  bursarAwardTerminateSchema,
  bursarListQuerySchema,
} from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { mapServiceError, validationError, viewerOf } from '../lib/http.js';
import { redactFinancialFields } from '../lib/redact-financial-fields.js';
import * as awards from '../services/awards.service.js';

// Award + baseline-freeze routes (spec 7, 11, M7). Per-route permission metadata is authored
// inline via fastify.requireCan so the M9 manifest generator emits the actions. Writes are
// FLOORED (bursar.award.create / amend / terminate); reads are bursar.award.read. Under the
// fail-closed boot invariant these deny for non-SuperUsers from M1 through M8 (dev + Playwright
// run as Skipper, a SuperUser). Reads project through the financial floor, exactly like the
// M2-M5 surfaces. There is NO baseline write route, by design: the baseline is insert-only at
// freeze and the migration 0249 triggers make it immutable thereafter.
export default async function awardRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  // ── Record an award: freeze the baseline in one transaction (409 on a live leveling lease) ──
  fastify.post(
    '/awards',
    { preHandler: [requireAuth, can('bursar.award.create')] },
    async (request, reply) => {
      const parsed = bursarAwardCreateSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const result = await awards.recordAward(viewerOf(request), parsed.data);
        reply.status(201);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── List awards (cursor pagination, ?filter[status|request_id|vendor_id]=) ────────────────
  fastify.get(
    '/awards',
    { preHandler: [requireAuth, can('bursar.award.read')] },
    async (request) => {
      const q = request.query as {
        cursor?: string;
        limit?: string;
        filter?: Record<string, string>;
      };
      const parsed = bursarListQuerySchema.safeParse(q);
      const limit = parsed.success ? parsed.data.limit : 25;
      const result = await awards.listAwards(viewerOf(request), {
        cursor: q.cursor,
        limit,
        status: q.filter?.status,
        requestId: q.filter?.request_id,
        vendorId: q.filter?.vendor_id,
      });
      return redactFinancialFields(result, await request.viewerCaps());
    },
  );

  // ── One award header ──────────────────────────────────────────────────────────────────────
  fastify.get(
    '/awards/:id',
    { preHandler: [requireAuth, can('bursar.award.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const result = await awards.getAward(viewerOf(request), id);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── The FROZEN baseline ledger (read-only; no write path exists) ────────────────────────────
  fastify.get(
    '/awards/:id/baseline',
    { preHandler: [requireAuth, can('bursar.award.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const result = await awards.getAwardBaseline(viewerOf(request), id);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── Amend: record a superseding award, flipping the predecessor to `superseded` ────────────
  fastify.post(
    '/awards/:id/amend',
    { preHandler: [requireAuth, can('bursar.award.amend')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = bursarAwardAmendSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const result = await awards.amendAward(viewerOf(request), id, parsed.data);
        reply.status(201);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── Terminate: header-only status change with an audit reason (baseline stays immutable) ────
  fastify.post(
    '/awards/:id/terminate',
    { preHandler: [requireAuth, can('bursar.award.terminate')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = bursarAwardTerminateSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const result = await awards.terminateAward(viewerOf(request), id, parsed.data);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );
}
