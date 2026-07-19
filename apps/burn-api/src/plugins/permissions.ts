// Per-action permission enforcement for burn-api.
//
// Registers the shared @bigbluebam/permissions HTTP plugin so route gates
// (fastify.requireCan) can reach the resolver in the api. Mirrors
// apps/bulwark-api/src/plugins/permissions.ts with one hard difference: the mode is a
// HARDCODED LITERAL, never read from process.env, and is asserted both before and after
// registration. See ../boot/assert-permissions-enforce.ts for the full rationale --
// short version, Burn is the first app with no legacy requireAuth+role gate behind
// requireCan, and packages/permissions/src/index.ts:291 returns early in 'warn' mode
// without ever denying, so a warn-mode burn-api leaves per-person cost rates and
// firm-wide financials open to any org member. On Railway the env route is not even
// available to us: ENV_HINTS is a flat global map with no per-service override.
//
// NOTE for later milestones: `fastify.canResolve` from this plugin is a hardcoded
// `return true` stub (packages/permissions/src/index.ts:307-319). It must NEVER be used
// as the source of a financial-flooring decision in Burn (spec 2.4 point 2, R3-S1);
// viewerCaps comes from an explicit fail-closed POST /internal/permissions/dual-read.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { httpPermissionsPlugin } from '@bigbluebam/permissions';
import { env } from '../env.js';
import {
  BURN_PERMISSIONS_MODE,
  assertPermissionsEnforcement,
} from '../boot/assert-permissions-enforce.js';

function getCaller(request: FastifyRequest): { user_id: string | null; org_id: string | null } {
  const user = request.user;
  return {
    user_id: user?.id ?? null,
    org_id: user?.active_org_id ?? user?.org_id ?? null,
  };
}

const burnPermissionsPlugin = fp(
  async (fastify: FastifyInstance) => {
    // The exact options object handed to the shared plugin. Held in a const so the
    // post-registration assertion reads back the value the plugin actually received,
    // rather than re-deriving it and asserting against itself.
    const options = {
      mode: BURN_PERMISSIONS_MODE,
      apiInternalUrl: env.BBB_API_INTERNAL_URL,
      internalSecret: env.INTERNAL_SERVICE_SECRET ?? '',
      getCaller,
    };

    assertPermissionsEnforcement(options.mode);
    await fastify.register(httpPermissionsPlugin, options);
    // Repointed at the RESOLVED mode: if a future refactor makes this env-driven or
    // otherwise mutates the options, boot fails loudly instead of opening the floors.
    assertPermissionsEnforcement(options.mode);

    fastify.log.info(
      { mode: options.mode, source: 'hardcoded_invariant' },
      'burn-api permissions plugin registered (enforcement asserted on, not env-configurable)',
    );
  },
  { name: 'burn-permissions', dependencies: ['auth'] },
);

export default burnPermissionsPlugin;
