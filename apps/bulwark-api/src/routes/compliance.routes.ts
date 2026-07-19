import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../plugins/auth.js';
import { mapServiceError, readViewer, viewerOf } from '../lib/http.js';
import * as compliance from '../services/compliance.service.js';
import { draftChase, approveAndSendChase } from '../services/send.service.js';

export default async function complianceRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get(
    '/compliance-docs',
    { preHandler: [requireAuth, can('bulwark.compliance.read')] },
    async (request) => {
      const q = request.query as { filter?: Record<string, string> };
      const data = await compliance.listComplianceDocs(readViewer(request), {
        vendorTierId: q.filter?.vendor_tier_id,
        validityStatus: q.filter?.validity_status,
        docType: q.filter?.doc_type,
      });
      return { data };
    },
  );

  fastify.post(
    '/compliance-docs/:id/chase',
    { preHandler: [requireAuth, can('bulwark.compliance.chase')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const viewer = viewerOf(request);
        await compliance.loadScopedComplianceDoc(viewer, id); // project-scope guard (SH1)
        const data = await draftChase(viewer.org_id, id);
        return { data };
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.post(
    '/compliance-docs/:id/approve-send',
    { preHandler: [requireAuth, can('bulwark.compliance.chase')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const viewer = viewerOf(request);
        await compliance.loadScopedComplianceDoc(viewer, id);
        const data = await approveAndSendChase(viewer.org_id, id, viewer.id);
        return { data };
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );
}
