import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  burnBulkConfirmUnpricedSchema,
  burnConfirmEnvelopeSchema,
  burnDeliverableUpdateSchema,
  burnListQuerySchema,
} from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { askerViewer, mapServiceError, readViewer, validationError, viewerOf } from '../lib/http.js';
import { redactFinancialFields } from '../lib/redact-financial-fields.js';
import * as deliverables from '../services/deliverables.service.js';

/**
 * A service-account caller is identified by the `bbam_svc_` API-key prefix, not by anything
 * in the request body. Spec 2.2.1 requires that `is_active` cannot be set by ANY
 * service-account token on ANY path, so this determination must not be spoofable.
 */
function isServiceAccountRequest(request: FastifyRequest): boolean {
  const header = request.headers.authorization;
  if (typeof header === 'string' && header.startsWith('Bearer bbam_svc_')) return true;
  return false;
}

export default async function deliverableRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get(
    '/deliverables',
    { preHandler: [requireAuth, can('burn.deliverable.read')] },
    async (request) => {
      const q = request.query as {
        cursor?: string;
        limit?: string;
        filter?: Record<string, string>;
      };
      const parsed = burnListQuerySchema.safeParse(q);
      const limit = parsed.success ? parsed.data.limit : 25;
      const caps = await request.viewerCaps();
      const result = await deliverables.listDeliverables(
        readViewer(request),
        {
          cursor: q.cursor,
          limit,
          engagementId: q.filter?.engagement_id,
          reviewStatus: q.filter?.review_status,
          lifecycleStatus: q.filter?.lifecycle_status,
          q: q.filter?.q,
        },
        // The `q` filter matches TITLE ONLY for a non-read_all caller (spec 2.4 point 5,
        // R3-S4). `search_tsv` contains `description` and `cited_span->>'quote'`, both of
        // which are floored in the response; letting a member filter on the index would let
        // them confirm the presence of any clause term one probe at a time and reconstruct a
        // rate schedule without ever reading a floored field.
        caps.financials_read_all,
      );
      // clauseText: true also strips `description`, `clause_ref` and `quote`. `title`
      // survives as the member-visible handle.
      return redactFinancialFields(result, caps, { clauseText: true });
    },
  );

  fastify.get(
    '/deliverables/:id',
    { preHandler: [requireAuth, can('burn.deliverable.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const result = await deliverables.getDeliverable(readViewer(request), id);
        return redactFinancialFields(result, await request.viewerCaps(), { clauseText: true });
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.patch(
    '/deliverables/:id',
    { preHandler: [requireAuth, can('burn.deliverable.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      // `.strict()` and the absence of envelope_amount / is_active from the schema make an
      // attempt to smuggle either key a 400 rather than a silent no-op.
      const parsed = burnDeliverableUpdateSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const asker = askerViewer(request);
        if (asker) await deliverables.getDeliverable(asker, id);
        const result = await deliverables.updateDeliverable(viewerOf(request), id, parsed.data);
        return redactFinancialFields(result, await request.viewerCaps(), { clauseText: true });
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.post(
    '/deliverables/:id/confirm-envelope',
    // burn.envelope.confirm is the ONLY permission that can set is_active (spec 2.2.1). It
    // is owner/admin tier in the built-in group defaults, and it is deliberately NOT backed
    // by an MCP tool: that is a security boundary, not an oversight.
    { preHandler: [requireAuth, can('burn.envelope.confirm')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = burnConfirmEnvelopeSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const result = await deliverables.confirmEnvelope(
          viewerOf(request),
          id,
          parsed.data,
          isServiceAccountRequest(request),
        );
        // A service-account caller gets 202 plus a proposal id, not a 403: the intent is
        // routed to a human who can approve it rather than discarded.
        if (result.mode === 'proposed') reply.status(202);
        return redactFinancialFields(result, await request.viewerCaps());
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.post(
    '/deliverables/bulk-confirm-unpriced',
    { preHandler: [requireAuth, can('burn.envelope.confirm')] },
    async (request, reply) => {
      const parsed = burnBulkConfirmUnpricedSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        // NEVER an even split (spec 2.2.2). These deliverables are confirmed as `unpriced`,
        // return allow_with_note/envelope_unpriced from the gate forever, and are excluded
        // from envelope_overrun and consumption_erosion.
        return await deliverables.bulkConfirmUnpriced(
          viewerOf(request),
          parsed.data,
          isServiceAccountRequest(request),
        );
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );
}
