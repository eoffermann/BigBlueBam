// Request-scoped viewerCaps: resolved ONCE per request, then threaded into the serializer.
//
// Spec 2.4 point 2 requires "resolved once per request". That is not only a latency
// concern: two probes in one request can straddle a resolver blip and return different
// answers, so one half of a response would floor and the other would not. Memoizing on the
// request object makes the answer a per-request constant.
//
// `fastify.canResolve` is deliberately NOT used here or anywhere in the flooring path. It
// is a hardcoded `return true` (packages/permissions/src/index.ts:307-319) and copying the
// bulwark-api precedent that calls it would floor nothing at all. See lib/viewer-caps.ts.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../env.js';
import {
  DENY_ALL_VIEWER_CAPS,
  askerUserIdOf,
  resolveViewerCaps,
  type ViewerCaps,
  type ViewerCapsDeps,
} from '../lib/viewer-caps.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The memoized capability set for this request. ALWAYS await this rather than reading
     * a cached field directly; the first call performs the dual-read and every later call
     * returns the same object.
     */
    viewerCaps(): Promise<ViewerCaps>;
  }
}

const viewerCapsPlugin = fp(
  async (fastify: FastifyInstance) => {
    const deps: ViewerCapsDeps = {
      apiInternalUrl: env.BBB_API_INTERNAL_URL,
      internalSecret: env.INTERNAL_SERVICE_SECRET,
      timeoutMs: env.UPSTREAM_TIMEOUT_MS,
      log: fastify.log,
    };

    // The prototype default is DENY-ALL, not null. If the onRequest hook below ever fails
    // to run (a plugin-ordering mistake, an early error handler, a future refactor), the
    // response floors everything rather than throwing "viewerCaps is not a function" into
    // an error handler that some route might swallow into an unfloored 200.
    fastify.decorateRequest('viewerCaps', function (this: FastifyRequest) {
      return Promise.resolve({ ...DENY_ALL_VIEWER_CAPS });
    });

    // onRequest runs BEFORE the auth plugin's preHandler, so request.user is not populated
    // yet. That is fine and deliberate: the hook only installs the memoizing closure, and
    // request.user is read lazily inside it, on the first call from a route handler.
    fastify.addHook('onRequest', async (request: FastifyRequest) => {
      let cached: Promise<ViewerCaps> | null = null;
      request.viewerCaps = () => {
        if (cached) return cached;
        const asker = askerUserIdOf(request.query);
        if (asker === 'invalid') {
          // An unresolvable asker fails the floored fields closed (R3-S2).
          cached = Promise.resolve({ ...DENY_ALL_VIEWER_CAPS });
          return cached;
        }
        cached = resolveViewerCaps(deps, {
          bearerUserId: request.user?.id ?? null,
          orgId: request.user?.active_org_id ?? request.user?.org_id ?? null,
          askerUserId: asker,
        });
        return cached;
      };
    });
  },
  { name: 'burn-viewer-caps', dependencies: ['auth'] },
);

export default viewerCapsPlugin;
