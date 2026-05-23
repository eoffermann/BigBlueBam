import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireBeaconReadAccess, requireBeaconEditAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as linkService from '../services/link.service.js';

const createLinkSchema = z.object({
  target_id: z.string().uuid(),
  link_type: z.enum(['RelatedTo', 'Supersedes', 'DependsOn', 'ConflictsWith', 'SeeAlso']),
});

export default async function linkRoutes(fastify: FastifyInstance) {
  // POST /beacons/:id/links — Create a link (Member+ can create)
  fastify.post<{ Params: { id: string } }>(
    '/beacons/:id/links',
    { preHandler: [requireAuth, fastify.requireCan('beacon.beacon_link.create'), requireBeaconEditAccess(), requireScope('read_write')] },
    async (request, reply) => {
      const { target_id, link_type } = createLinkSchema.parse(request.body);
      const link = await linkService.createLink(
        request.params.id,
        target_id,
        link_type,
        request.user!.id,
        request.user!.org_id,
      );
      if (!link) {
        // Conflict — link already exists
        return reply.status(409).send({
          error: {
            code: 'CONFLICT',
            message: 'This link already exists',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.status(201).send({ data: link });
    },
  );

  // GET /beacons/:id/links — List all links for a beacon
  fastify.get<{ Params: { id: string } }>(
    '/beacons/:id/links',
    { preHandler: [requireAuth, requireBeaconReadAccess(), shadowOnly('beacon.beacon_link.get')] },
    async (request, reply) => {
      const beacon = (request as any).beacon;
      const links = await linkService.getLinks(beacon.id);
      return reply.send({ data: links });
    },
  );

  // DELETE /beacons/:id/links/:linkId — Remove a link (Owner/Admin)
  fastify.delete<{ Params: { id: string; linkId: string } }>(
    '/beacons/:id/links/:linkId',
    { preHandler: [requireAuth, requireBeaconEditAccess(), shadowOnly('beacon.beacon_link.delete'), requireScope('read_write')] },
    async (request, reply) => {
      const beacon = (request as any).beacon;
      const deleted = await linkService.removeLink(request.params.linkId, beacon.id);
      if (!deleted) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Link not found',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply.send({ data: deleted });
    },
  );
}
