// Request-scoped viewerCaps: resolved ONCE per request, then threaded into the serializer.
//
// Ported from burn-api/src/plugins/viewer-caps.ts. Memoizing on the request object makes the
// answer a per-request constant so one half of a response cannot floor while the other does
// not. `fastify.canResolve` is deliberately NOT used here or anywhere in the flooring/seal
// path (it is a hardcoded `return true`). See lib/viewer-caps.ts.

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
    /** The memoized capability set for this request. ALWAYS await this. */
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

    // The prototype default is DENY-ALL, not null: if the onRequest hook ever fails to run,
    // the response floors everything rather than throwing.
    fastify.decorateRequest('viewerCaps', function (this: FastifyRequest) {
      return Promise.resolve({ ...DENY_ALL_VIEWER_CAPS });
    });

    fastify.addHook('onRequest', async (request: FastifyRequest) => {
      let cached: Promise<ViewerCaps> | null = null;
      request.viewerCaps = () => {
        if (cached) return cached;
        const asker = askerUserIdOf(request.query);
        if (asker === 'invalid') {
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
  { name: 'bursar-viewer-caps', dependencies: ['auth'] },
);

export default viewerCapsPlugin;
