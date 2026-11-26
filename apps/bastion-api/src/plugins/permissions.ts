// Per-action permission enforcement for bastion-api, ported from bursar-api. The mode is a
// hardcoded literal asserted before and after registration, and onUnknown is 'deny'. See
// ../boot/assert-permissions-enforce.ts.
//
// `fastify.canResolve` from the shared plugin is a hardcoded `return true` stub and must never
// decide anything in Bastion.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { httpPermissionsPlugin } from '@bigbluebam/permissions';
import { env } from '../env.js';
import {
  BASTION_PERMISSIONS_MODE,
  BASTION_PERMISSIONS_ON_UNKNOWN,
  assertPermissionsEnforcement,
} from '../boot/assert-permissions-enforce.js';

function getCaller(request: FastifyRequest): { user_id: string | null; org_id: string | null } {
  const user = request.user;
  return {
    user_id: user?.id ?? null,
    org_id: user?.active_org_id ?? user?.org_id ?? null,
  };
}

const bastionPermissionsPlugin = fp(
  async (fastify: FastifyInstance) => {
    const options = {
      mode: BASTION_PERMISSIONS_MODE,
      apiInternalUrl: env.BBB_API_INTERNAL_URL,
      internalSecret: env.INTERNAL_SERVICE_SECRET,
      onUnknown: BASTION_PERMISSIONS_ON_UNKNOWN,
      getCaller,
    };

    assertPermissionsEnforcement(options.mode, options.onUnknown);
    await fastify.register(httpPermissionsPlugin, options);
    assertPermissionsEnforcement(options.mode, options.onUnknown);

    fastify.log.info(
      { mode: options.mode, on_unknown: options.onUnknown, source: 'hardcoded_invariant' },
      'bastion-api permissions plugin registered (enforcement on and fail-closed, not env-configurable)',
    );
  },
  { name: 'bastion-permissions', dependencies: ['auth'] },
);

export default bastionPermissionsPlugin;
