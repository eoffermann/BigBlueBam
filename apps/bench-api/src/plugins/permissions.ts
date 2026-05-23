// Wave D Phase 3: per-action permission enforcement for bench-api.
//
// Registers the shared @bigbluebam/permissions HTTP plugin so route gates
// (fastify.requireCan and shadowOnly) can reach the resolver in the api.
// Mirrors the apps/api permissions plugin shape; the satellite difference
// is that the resolver call goes over HTTP rather than running in-process.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { httpPermissionsPlugin } from '@bigbluebam/permissions';
import { env } from '../env.js';

function getCaller(request: FastifyRequest): { user_id: string | null; org_id: string | null } {
  const user = request.user;
  return {
    user_id: user?.id ?? null,
    org_id: user?.active_org_id ?? user?.org_id ?? null,
  };
}

const benchPermissionsPlugin = fp(
  async (fastify: FastifyInstance) => {
    await fastify.register(httpPermissionsPlugin, {
      mode: env.BBB_PERMISSIONS_ENFORCE,
      apiInternalUrl: env.BBB_API_INTERNAL_URL,
      internalSecret: env.INTERNAL_SERVICE_SECRET ?? '',
      getCaller,
    });
    fastify.log.info({ mode: env.BBB_PERMISSIONS_ENFORCE }, 'bench-api permissions plugin registered');
  },
  { name: 'bench-permissions', dependencies: ['auth'] },
);

export default benchPermissionsPlugin;
