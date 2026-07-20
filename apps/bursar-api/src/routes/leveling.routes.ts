import type { FastifyInstance } from 'fastify';
import { bursarCoverageOverrideSchema, bursarLevelSchema, bursarListQuerySchema } from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { mapServiceError, validationError, viewerOf } from '../lib/http.js';
import { redactFinancialFields } from '../lib/redact-financial-fields.js';
import * as leveling from '../services/leveling.service.js';

// Leveling + diff routes (spec 11 / 3-4-10, M5). Per-route permission metadata is authored inline
// via fastify.requireCan (M9 walks it into the catalog): the async-start leveling run is FLOORED
// (bursar.leveling.run); every read is bursar.coverage.read; a human override is
// bursar.coverage.override. Under the fail-closed boot invariant these deny for non-SuperUsers from
// M1 through M8 (dev + Playwright run as Skipper, a SuperUser). Reads project through the financial
// floor here, exactly like the M2-M4 surfaces.
export default async function levelingRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  // ── Preflight + async-start leveling (202 + run id; 422 rejected_limits; 409 on a live lease) ──
  fastify.post(
    '/requests/:id/level',
    { preHandler: [requireAuth, can('bursar.leveling.run')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = bursarLevelSchema.safeParse(request.body ?? {});
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const result = await leveling.levelRequest(viewerOf(request), id, parsed.data);
        if (result.kind === 'preflight') return { data: result.preflight };
        if (result.kind === 'rejected_limits') {
          reply.status(422);
          return {
            error: {
              code: 'REJECTED_LIMITS',
              message: `Too many offers to level in one run: ${result.preflight.offers} exceeds the per-run cap.`,
              details: [],
              request_id: request.id,
            },
            preflight: result.preflight,
            run_id: result.run_id,
          };
        }
        reply.status(202);
        return { data: { run_id: result.run_id, resumed: result.resumed, enqueued: result.enqueued, preflight: result.preflight } };
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── Authoritative progress ────────────────────────────────────────────────────
  fastify.get(
    '/requests/:id/leveling-runs',
    { preHandler: [requireAuth, can('bursar.coverage.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return await leveling.listLevelingRuns(viewerOf(request), id);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── The coverage matrix ───────────────────────────────────────────────────────
  fastify.get(
    '/requests/:id/matrix',
    { preHandler: [requireAuth, can('bursar.coverage.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const result = await leveling.getMatrix(viewerOf(request), id);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── The §4.7 exclusion diff (satisfies the diff-completeness invariant) ─────────
  fastify.get(
    '/requests/:id/exclusion-diff',
    { preHandler: [requireAuth, can('bursar.coverage.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        return await leveling.getExclusionDiff(viewerOf(request), id);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── Comparable totals ─────────────────────────────────────────────────────────
  fastify.get(
    '/requests/:id/totals',
    { preHandler: [requireAuth, can('bursar.coverage.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const result = await leveling.getTotals(viewerOf(request), id);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── One coverage row ──────────────────────────────────────────────────────────
  fastify.get(
    '/coverage/:id',
    { preHandler: [requireAuth, can('bursar.coverage.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const result = await leveling.getCoverage(viewerOf(request), id);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── Human override (floored) ────────────────────────────────────────────────────
  fastify.post(
    '/coverage/:id/override',
    { preHandler: [requireAuth, can('bursar.coverage.override')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = bursarCoverageOverrideSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const result = await leveling.overrideCoverage(viewerOf(request), id, parsed.data);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  // ── The internal adjudication review queue ──────────────────────────────────────
  fastify.get(
    '/review',
    { preHandler: [requireAuth, can('bursar.coverage.read')] },
    async (request, reply) => {
      const q = request.query as { limit?: string };
      const parsed = bursarListQuerySchema.safeParse(q);
      const limit = parsed.success ? parsed.data.limit : 50;
      try {
        return await leveling.getReview(viewerOf(request), limit);
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );
}
