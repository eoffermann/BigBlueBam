import type { FastifyInstance } from 'fastify';
import { requireAuth } from '../plugins/auth.js';
import { requireBeaconReadAccess } from '../middleware/authorize.js';
import { shadowOnly } from '../middleware/dual-read.js';
import * as versionService from '../services/version.service.js';

export default async function versionRoutes(fastify: FastifyInstance) {
  // GET /beacons/:id/versions — List version history
  fastify.get<{ Params: { id: string } }>(
    '/beacons/:id/versions',
    { preHandler: [requireAuth, requireBeaconReadAccess(), shadowOnly('beacon.beacon_version.get')] },
    async (request, reply) => {
      const beacon = (request as any).beacon;
      const versions = await versionService.listVersions(beacon.id);
      return reply.send({ data: versions });
    },
  );

  // GET /beacons/:id/versions/:v — Get a specific version
  fastify.get<{ Params: { id: string; v: string } }>(
    '/beacons/:id/versions/:v',
    { preHandler: [requireAuth, requireBeaconReadAccess(), shadowOnly('beacon.beacon_version.get')] },
    async (request, reply) => {
      const beacon = (request as any).beacon;
      const versionNumber = parseInt(request.params.v, 10);

      if (Number.isNaN(versionNumber) || versionNumber < 1) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Version must be a positive integer',
            details: [],
            request_id: request.id,
          },
        });
      }

      const version = await versionService.getVersion(beacon.id, versionNumber);
      if (!version) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: `Version ${versionNumber} not found`,
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: version });
    },
  );
}
