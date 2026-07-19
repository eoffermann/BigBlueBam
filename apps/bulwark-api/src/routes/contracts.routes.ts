import type { FastifyInstance } from 'fastify';
import {
  bulwarkCreateContractSchema,
  bulwarkUpdateContractSchema,
  bulwarkListQuerySchema,
} from '@bigbluebam/shared';
import { requireAuth } from '../plugins/auth.js';
import { preflightAccess } from '../lib/can-access.client.js';
import { mapServiceError, notFound, readViewer, validationError, viewerOf } from '../lib/http.js';
import * as contracts from '../services/contracts.service.js';

// Bulwark contracts surface (spec 5.1). Every route is permission-gated AND project-scoped.
export default async function contractRoutes(fastify: FastifyInstance) {
  const can = (p: string) => fastify.requireCan(p);

  fastify.get(
    '/contracts',
    { preHandler: [requireAuth, can('bulwark.contract.read')] },
    async (request) => {
      const q = request.query as { cursor?: string; limit?: string; filter?: Record<string, string> };
      const parsed = bulwarkListQuerySchema.safeParse(q);
      const limit = parsed.success ? parsed.data.limit : 25;
      return contracts.listContracts(readViewer(request), {
        cursor: q.cursor,
        limit,
        status: q.filter?.status,
        projectId: q.filter?.project_id,
      });
    },
  );

  fastify.post(
    '/contracts',
    { preHandler: [requireAuth, can('bulwark.contract.write')] },
    async (request, reply) => {
      const parsed = bulwarkCreateContractSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      const viewer = viewerOf(request);
      // Bin can_access preflight (S3): reject not_found if the caller cannot see the asset.
      const ok = await preflightAccess(viewer.id, 'bin.asset', parsed.data.bin_asset_id);
      if (!ok) return notFound(request, reply, 'Bin asset not found');
      try {
        const contract = await contracts.createContract(viewer, parsed.data);
        return reply.status(201).send({ data: contract });
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.get(
    '/contracts/:id',
    { preHandler: [requireAuth, can('bulwark.contract.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const data = await contracts.getContractWithRollup(readViewer(request), id);
        return { data };
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.patch(
    '/contracts/:id',
    { preHandler: [requireAuth, can('bulwark.contract.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const parsed = bulwarkUpdateContractSchema.safeParse(request.body);
      if (!parsed.success) return validationError(request, reply, parsed.error);
      try {
        const data = await contracts.updateContract(viewerOf(request), id, parsed.data);
        return { data };
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.delete(
    '/contracts/:id',
    { preHandler: [requireAuth, can('bulwark.contract.delete')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        await contracts.deleteContract(viewerOf(request), id);
        return { data: { deleted: true, id } };
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.post(
    '/contracts/:id/extract',
    { preHandler: [requireAuth, can('bulwark.contract.write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const viewer = viewerOf(request);
        // Re-preflight the Bin asset (S3) before re-enqueuing.
        const contract = await contracts.loadScopedContract(viewer, id);
        const ok = await preflightAccess(viewer.id, 'bin.asset', contract.bin_asset_id);
        if (!ok) return notFound(request, reply, 'Bin asset not found');
        const data = await contracts.reExtract(viewer, id);
        return reply.status(202).send({ data });
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );

  fastify.get(
    '/contracts/:id/obligations',
    { preHandler: [requireAuth, can('bulwark.obligation.read')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      try {
        const data = await contracts.listContractObligations(readViewer(request), id);
        return { data };
      } catch (err) {
        if (mapServiceError(request, reply, err)) return reply;
        throw err;
      }
    },
  );
}
