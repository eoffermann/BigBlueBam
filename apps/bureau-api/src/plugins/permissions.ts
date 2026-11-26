// Per-action permission enforcement for bureau-api (issue #153).
//
// Registers the shared @bigbluebam/permissions HTTP plugin so every route's
// fastify.requireCan('bureau.<resource>.<verb>') gate reaches the resolver in
// the api. Same shape as blueprint-api's plugin. The bureau.* catalog rows and
// their built-in group defaults are seeded by the permissions delta migration
// and the bureau builtin_group_defaults migration that landed with this file.

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

const bureauPermissionsPlugin = fp(
  async (fastify: FastifyInstance) => {
    await fastify.register(httpPermissionsPlugin, {
      mode: env.BBB_PERMISSIONS_ENFORCE,
      apiInternalUrl: env.BBB_API_INTERNAL_URL,
      internalSecret: env.INTERNAL_SERVICE_SECRET ?? '',
      getCaller,
    });
    fastify.log.info({ mode: env.BBB_PERMISSIONS_ENFORCE }, 'bureau-api permissions plugin registered');
  },
  { name: 'bureau-permissions', dependencies: ['auth'] },
);

export default bureauPermissionsPlugin;
