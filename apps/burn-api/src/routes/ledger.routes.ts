import type { FastifyInstance } from 'fastify';
import {
  BurnUnscopedBucket,
  burnAttributionBulkSchema,
  burnAttributionCreateSchema,
  burnAttributionUpdateSchema,
  burnListQuerySchema,
} from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { askerViewer, mapServiceError, readViewer, validationError, viewerOf } from '../lib/http.js';
import { redactFinancialFields } from '../lib/redact-financial-fields.js';
import { publishBurnFrame } from '../lib/realtime.js';
import { runInOrgScope } from '../plugins/rls.js';
import * as ledger from '../services/ledger.service.js';

export default async function ledgerRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get(
    '/work-items',
    { preHandler: [requireAuth, can('burn.attribution.read')] },
    async (request) => {
      const q = request.query as { cursor?: string; limit?: string; filter?: Record<string, string> };
      const parsed = burnListQuerySchema.safeParse(q);
      const limit = parsed.success ? parsed.data.limit : 25;
      const result = await ledger.listWorkItems(readViewer(request), {
        cursor: q.cursor,
        limit,
        attributionState: q.filter?.attribution_state,
        projectId: q.filter?.project_id,
        sourceType: q.filter?.source_type,
      });
      // THE surveillance-join surface. For a single bam.time_entry row,
      // cost_amount / (minutes / 60) IS that person's hourly cost rate to the cent. One row
      // is a full disclosure, which is why the flooring is centralized and unconditional.
      return redactFinancialFields(result, await request.viewerCaps());
    },
  );

  fastify.get(
    '/unscoped',
    { preHandler: [requireAuth, can('burn.attribution.read')] },
    async (request) => {
      const q = request.query as { cursor?: string; limit?: string; filter?: Record<string, string> };
      const parsed = burnListQuerySchema.safeParse(q);
      const limit = parsed.success ? parsed.data.limit : 25;
      const bucketParsed = BurnUnscopedBucket.safeParse(q.filter?.bucket);
      const result = await ledger.listUnscoped(readViewer(request), {
        cursor: q.cursor,
        limit,
        bucket: bucketParsed.success ? bucketParsed.data : undefined,
      });
      return redactFinancialFields(result, await request.viewerCaps());
    },
  );

  fastify.get(
    '/queue-health',
    { preHandler: [requireAuth, can('burn.attribution.read')] },
    async (request) => {
      const result = await ledger.queueHealth(readViewer(request));
      return redactFinancialFields(result, await request.viewerCaps());
    },
  );

  fastify.get(
    '/attributions',
    { preHandler: [requireAuth, can('burn.attribution.read')] },
    async (request) => {
      const q = request.query as { cursor?: string; limit?: string; filter?: Record<string, string> };
      const parsed = burnListQuerySchema.safeParse(q);
      const limit = parsed.success ? parsed.data.limit : 25;
      const result = await ledger.listAttributions(readViewer(request), {
        cursor: q.cursor,
        limit,
        state: q.filter?.state,
        deliverableId: q.filter?.deliverable_id,
      });
      // R2-S3: /v1/attributions projects the SAME amounts as /v1/work-items through the
      // work-item join. Round 1 floored one and not the other; the identical disclosure ran
      // on the unfloored route.
      return redactFinancialFields(result, await request.viewerCaps());
    },
  );

  fastify.post(
    '/attributions',
    { preHandler: [requireAuth, can('burn.attribution.write')] },
    async (request, reply) => {
      const parsed = burnAttributionCreateSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const result = await ledger.createAttribution(viewerOf(request), parsed.data);
        await emitReviewed(request.user!.active_org_id ?? request.user!.org_id, result.data!);
        reply.status(201);
        return redactFinancialFields({ data: result.data }, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.patch(
    '/attributions/:id',
    { preHandler: [requireAuth, can('burn.attribution.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = burnAttributionUpdateSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const asker = askerViewer(request);
        if (asker) {
          // Narrow against the acting human before the bearer performs the write.
          await ledger.listAttributions(asker, { limit: 1, deliverableId: undefined });
        }
        const result = await ledger.updateAttribution(viewerOf(request), id, parsed.data);
        await emitReviewed(request.user!.active_org_id ?? request.user!.org_id, result.data!);
        return redactFinancialFields({ data: result.data }, await request.viewerCaps());
      } catch (err) {
        // A ConflictError carries the CURRENT state, and mapServiceError puts it on the 409
        // body so a concurrent triage can re-render without a second round trip.
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.post(
    '/attributions/bulk',
    { preHandler: [requireAuth, can('burn.attribution.write')] },
    async (request, reply) => {
      const parsed = burnAttributionBulkSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        // Per-item `{ applied, conflicted, failed }`, capped at 200 by the schema. Not
        // all-or-nothing: a cluster triage where two rows were concurrently edited must
        // apply the other 78 rather than roll back the operator's whole afternoon.
        const result = await ledger.bulkUpdateAttributions(viewerOf(request), parsed.data);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  /** Refs only. No dollars, no client names. Never blocks the write it describes. */
  async function emitReviewed(orgId: string, attribution: { id: string; state: string; chain_root_id: string | null }) {
    try {
      const projectIds = await runInOrgScope(orgId, (tx) =>
        ledger.projectsForChain(tx, orgId, attribution.chain_root_id),
      );
      await publishBurnFrame(orgId, projectIds, {
        type: 'attribution.reviewed',
        attribution_id: attribution.id,
        state: attribution.state as never,
      });
    } catch {
      // Advisory only (spec 6.2). The client refetches on reconnect.
    }
  }
}
