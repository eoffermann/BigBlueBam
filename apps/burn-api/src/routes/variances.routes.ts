import type { FastifyInstance } from 'fastify';
import {
  burnChangeOrderDraftSchema,
  burnListQuerySchema,
  burnVarianceUpdateSchema,
} from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { mapServiceError, readViewer, validationError, viewerOf } from '../lib/http.js';
import { redactFinancialFields } from '../lib/redact-financial-fields.js';
import { publishBurnFrame } from '../lib/realtime.js';
import { runInOrgScope } from '../plugins/rls.js';
import * as variances from '../services/variances.service.js';
import * as ledger from '../services/ledger.service.js';

export default async function varianceRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get(
    '/variances',
    { preHandler: [requireAuth, can('burn.variance.read')] },
    async (request) => {
      const q = request.query as { cursor?: string; limit?: string; filter?: Record<string, string> };
      const parsed = burnListQuerySchema.safeParse(q);
      const limit = parsed.success ? parsed.data.limit : 25;
      const result = await variances.listVariances(readViewer(request), {
        cursor: q.cursor,
        limit,
        status: q.filter?.status,
        kind: q.filter?.kind,
        engagementId: q.filter?.engagement_id,
      });
      // `amount` is floored, and `detail` is JSONB so the serializer's RECURSIVE walk is what
      // stops the same dollars reappearing one level down inside detail.refs.
      return redactFinancialFields(result, await request.viewerCaps());
    },
  );

  fastify.patch(
    '/variances/:id',
    // burn.variance.write, NOT burn.variance.read: a mutation is never authorized by an
    // is_read:true permission (spec 11.2).
    { preHandler: [requireAuth, can('burn.variance.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = burnVarianceUpdateSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const result = await variances.updateVariance(viewerOf(request), id, parsed.data);
        const orgId = request.user!.active_org_id ?? request.user!.org_id;
        await emitVariance(orgId, result.data!);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.post(
    '/change-orders',
    { preHandler: [requireAuth, can('burn.changeorder.draft')] },
    async (request, reply) => {
      const parsed = burnChangeOrderDraftSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        // The draft is NEVER sent. It becomes an agent_proposals row, which IS the HITL
        // step -- which is why the matching MCP tool needs no confirm token.
        const result = await variances.draftChangeOrder(viewerOf(request), parsed.data);
        reply.status(201);
        return result;
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.get(
    '/change-orders/:id',
    { preHandler: [requireAuth, can('burn.changeorder.draft')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const result = await variances.getChangeOrder(readViewer(request), id);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  async function emitVariance(
    orgId: string,
    row: { id: string; variance_kind: string; severity: string; chain_root_id: string | null; engagement_id: string | null },
  ) {
    try {
      const projectIds = await runInOrgScope(orgId, (tx) =>
        ledger.projectsForChain(tx, orgId, row.chain_root_id),
      );
      await publishBurnFrame(orgId, projectIds, {
        type: 'variance.detected',
        variance_id: row.id,
        kind: row.variance_kind as never,
        severity: row.severity as never,
        engagement_id: row.engagement_id,
      });
    } catch {
      // advisory only
    }
  }
}
