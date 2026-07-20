// Per-action permission enforcement for bursar-api.
//
// Registers the shared @bigbluebam/permissions HTTP plugin so route gates
// (fastify.requireCan) can reach the resolver in the api. Ported from
// burn-api/src/plugins/permissions.ts with the same two hard differences from the other
// satellites. First, the mode is a HARDCODED LITERAL, never read from process.env, and is
// asserted both before and after registration. Second, `onUnknown` is 'deny' rather than the
// shared plugin's default 'allow', so an unresolvable decision is a 403 instead of a
// pass-through. See ../boot/assert-permissions-enforce.ts for the full rationale.
//
// NOTE for later milestones: `fastify.canResolve` from this plugin is a hardcoded
// `return true` stub. It must NEVER be used as the source of a financial-flooring or seal
// decision in Bursar (spec 5.6 / 13.3); viewerCaps comes from an explicit fail-closed POST
// /internal/permissions/dual-read.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { httpPermissionsPlugin } from '@bigbluebam/permissions';
import { env } from '../env.js';
import {
  BURSAR_PERMISSIONS_MODE,
  BURSAR_PERMISSIONS_ON_UNKNOWN,
  assertPermissionsEnforcement,
} from '../boot/assert-permissions-enforce.js';

function getCaller(request: FastifyRequest): { user_id: string | null; org_id: string | null } {
  const user = request.user;
  return {
    user_id: user?.id ?? null,
    org_id: user?.active_org_id ?? user?.org_id ?? null,
  };
}

const bursarPermissionsPlugin = fp(
  async (fastify: FastifyInstance) => {
    const options = {
      mode: BURSAR_PERMISSIONS_MODE,
      apiInternalUrl: env.BBB_API_INTERNAL_URL,
      internalSecret: env.INTERNAL_SERVICE_SECRET,
      onUnknown: BURSAR_PERMISSIONS_ON_UNKNOWN,
      getCaller,
    };

    assertPermissionsEnforcement(options.mode, options.onUnknown);
    await fastify.register(httpPermissionsPlugin, options);
    // Repointed at the RESOLVED options: a future refactor that mutates them fails loudly at
    // boot rather than silently opening the surfaces.
    assertPermissionsEnforcement(options.mode, options.onUnknown);

    fastify.log.info(
      { mode: options.mode, on_unknown: options.onUnknown, source: 'hardcoded_invariant' },
      'bursar-api permissions plugin registered (enforcement asserted on and fail-closed, not env-configurable)',
    );
  },
  { name: 'bursar-permissions', dependencies: ['auth'] },
);

export default bursarPermissionsPlugin;
