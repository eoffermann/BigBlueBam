// Permissions plugin wiring. Wave A wires the plugin in mode 'off' so
// every requireCan() call no-ops; the schema and resolver land in this
// PR but no behavior changes. Wave B will plug in a real contextLoader
// (queries account_group_memberships + permission_group_defaults +
// account_permissions for the current user/org) and flip the mode to
// 'warn' for the divergence soak. See docs/permissions-overhaul-plan.md.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { permissionsPlugin } from '@bigbluebam/permissions';
import type { PermissionContext, PermissionScope } from '@bigbluebam/permissions';
import { env } from '../env.js';

/**
 * Wave A stub. Returns null (treated as unauthenticated by the plugin)
 * because mode='off' never invokes the loader. Replaced in Wave B.
 */
async function loadPermissionContextStub(
  _request: FastifyRequest,
): Promise<PermissionContext | null> {
  return null;
}

function loadScopeFromRequest(request: FastifyRequest): PermissionScope {
  // The auth plugin populates request.user.active_org_id. The plan is to
  // surface project_id in Wave B once we audit which routes actually take
  // a project_id param vs which infer it from the entity being acted on.
  // For now scope is org-only.
  const orgId = (request as unknown as { user?: { active_org_id?: string } }).user?.active_org_id ?? null;
  return { org_id: orgId };
}

export const permissionsApiPlugin = fp(
  async (fastify: FastifyInstance) => {
    await fastify.register(permissionsPlugin, {
      mode: env.BBB_PERMISSIONS_ENFORCE,
      contextLoader: loadPermissionContextStub,
      scopeLoader: loadScopeFromRequest,
    });
    fastify.log.info(
      { mode: env.BBB_PERMISSIONS_ENFORCE },
      'permissions plugin registered',
    );
  },
  { name: 'permissions-api' },
);
