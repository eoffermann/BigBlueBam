// Per-action permission enforcement for bastion-api, ported from bursar-api. The mode is a
// hardcoded literal asserted before and after registration, and onUnknown is 'deny'. See
// ../boot/assert-permissions-enforce.ts.
//
// `fastify.canResolve` from the shared plugin is a hardcoded `return true` stub and must never
// decide anything in Bastion.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHttpPermissionChecker, httpPermissionsPlugin } from '@bigbluebam/permissions';

declare module 'fastify' {
  interface FastifyInstance {
    /** Does the caller (and the asker, if any) hold `permissionId`? Fail-closed (never the shared canResolve stub). */
    bastionCan(request: FastifyRequest, permissionId: string): Promise<boolean>;
    /** preHandler: when `asker_user_id` is given, the asker must hold `permissionId` too (#217). */
    requireAskerCan(permissionId: string): (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
    /**
     * Does a given user (not the caller) hold `permissionId` in an org? Fail-closed. The public
     * auditor room re-checks its creator on every request (spec 5.2).
     */
    bastionUserCan(userId: string, orgId: string, permissionId: string): Promise<boolean>;
  }
}
import { env } from '../env.js';
import { askerUserIdOf } from '../lib/asker.js';
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

    // A boolean probe for decisions INSIDE a route (e.g. may this caller see restricted evidence,
    // M5), with the same enforcement semantics as requireCan: fail-closed on an unknown answer.
    const checker = createHttpPermissionChecker({
      mode: options.mode,
      onUnknown: options.onUnknown,
      apiInternalUrl: options.apiInternalUrl,
      internalSecret: options.internalSecret,
    });
    const log = (request: FastifyRequest) => request.log as { warn: (o: object, m: string) => void };
    // With `asker_user_id` (an agent reading for a person, #217) the answer is the intersection of
    // the bearer's and the asker's permissions: it narrows, never widens.
    fastify.decorate('bastionCan', async (request: FastifyRequest, permissionId: string): Promise<boolean> => {
      const caller = getCaller(request);
      if (!caller.user_id) return false;
      if (!(await checker({ user_id: caller.user_id, org_id: caller.org_id }, permissionId, log(request)))) return false;
      const asker = askerUserIdOf(request.query);
      if (asker === null) return true;
      if (asker === 'invalid') return false;
      return checker({ user_id: asker, org_id: caller.org_id }, permissionId, log(request));
    });

    const quietLog = { warn: (o: object, m: string) => fastify.log.warn(o, m) };
    fastify.decorate('bastionUserCan', async (userId: string, orgId: string, permissionId: string): Promise<boolean> => {
      try {
        return await checker({ user_id: userId, org_id: orgId }, permissionId, quietLog);
      } catch {
        return false;
      }
    });

    // preHandler for detail-bearing reads: the asker, when given, must also hold the route's
    // permission (requireCan checks only the bearer). Runs after requireCan.
    fastify.decorate('requireAskerCan', (permissionId: string) => async (request: FastifyRequest, reply: FastifyReply) => {
      const asker = askerUserIdOf(request.query);
      if (asker === null) return;
      const send = (status: number, code: string, message: string) =>
        reply.status(status).send({ error: { code, message, details: [{ field: 'asker_user_id', issue: code.toLowerCase() }], request_id: request.id } });
      if (asker === 'invalid') return send(400, 'VALIDATION_ERROR', 'asker_user_id must be a user id.');
      const caller = getCaller(request);
      if (!(await checker({ user_id: asker, org_id: caller.org_id }, permissionId, log(request)))) {
        return send(403, 'ASKER_FORBIDDEN', 'The person you are asking for may not see this.');
      }
    });

    fastify.log.info(
      { mode: options.mode, on_unknown: options.onUnknown, source: 'hardcoded_invariant' },
      'bastion-api permissions plugin registered (enforcement on and fail-closed, not env-configurable)',
    );
  },
  { name: 'bastion-permissions', dependencies: ['auth'] },
);

export default bastionPermissionsPlugin;
