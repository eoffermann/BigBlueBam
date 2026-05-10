// Wave B dual-read wrapper.
//
// Wraps a sample-route's existing legacy gate so the new resolver runs in
// parallel and divergences land in permissions_divergence_log. The legacy
// gate's decision remains canonical — if it 4xx's, the route 4xx's; if it
// passes, the route runs even when the new resolver disagrees.
//
// Usage in a sample route:
//
//   fastify.post('/projects', {
//     preHandler: [
//       fastify.requireAuth,
//       dualReadGate({
//         legacy: fastify.requireMinRole('admin'),
//         permission: 'bam.project.create',
//       }),
//     ],
//   }, handler);
//
// Wave C replaces these `dualReadGate(...)` calls with bare
// `fastify.requireCan('bam.project.create')` and removes the legacy gate.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Decision } from '@bigbluebam/permissions';

/**
 * Async preHandler signature used by every legacy gate in apps/api/src/
 * (requireAuth, requireMinRole, requireRole, requireProjectRole, etc).
 * Fastify's `preHandlerHookHandler` type carries extra params we never
 * use — narrowing to this 2-arg async form keeps the wrapper's call
 * sites clean.
 */
type AsyncPreHandler = (
  this: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<void> | void;

interface DualReadOptions {
  /** The legacy preHandler being shadowed. */
  legacy: AsyncPreHandler;
  /** The permission ID the new resolver should check. */
  permission: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the legacy gate via reply.code() or by passing through. */
    legacyPermissionDecision?: Decision;
  }
}

export function dualReadGate(opts: DualReadOptions) {
  return async function dualReadHandler(this: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
    // Run the legacy gate first. It either sets reply.sent=true with a
    // 4xx (denial) or returns without touching reply (pass).
    //
    // We deliberately avoid wrapping reply.send: Fastify's onSend hook
    // chain captures the prototype method at hook-registration time, and
    // reassigning reply.send mid-request causes "Reply was already sent"
    // errors when the route's actual response is later constructed.
    await opts.legacy.call(this, request, reply);

    const legacyDenied = reply.sent && reply.statusCode >= 400;
    request.legacyPermissionDecision = legacyDenied ? 'deny' : 'allow';

    // ALWAYS run the resolver — divergence telemetry needs to capture
    // both legacy-denies-but-resolver-allows AND legacy-allows-but-
    // resolver-denies. requireCan in 'warn' mode never 4xx's, so this
    // is safe to call even after legacy already denied.
    //
    // The package's warn-mode path bails out cleanly if the context
    // loader returns null, without sending any response.
    const checker = (this as unknown as { requireCan?: (id: string) => AsyncPreHandler }).requireCan;
    if (checker) {
      const fn = checker(opts.permission);
      try {
        await fn.call(this, request, reply);
      } catch (err) {
        // Resolver bugs must not break the legacy gate's verdict.
        request.log.warn(
          { err, permission: opts.permission },
          'dual-read: resolver threw; legacy decision stands',
        );
      }
    }
  };
}

/**
 * Convenience for routes that have NO legacy gate — common for
 * post-Wave-B routes where the original code is `requireAuth` with no
 * role check. We still want the resolver to run + record so we can
 * tell whether per-action permissions have a sane default for those
 * actions.
 */
export function shadowOnly(permission: string) {
  return async function shadowHandler(this: FastifyInstance, request: FastifyRequest, reply: FastifyReply) {
    request.legacyPermissionDecision = 'allow'; // legacy is "no role gate"
    const checker = (this as unknown as { requireCan?: (id: string) => AsyncPreHandler }).requireCan;
    if (checker) {
      const fn = checker(permission);
      await fn.call(this, request, reply);
    }
  };
}
