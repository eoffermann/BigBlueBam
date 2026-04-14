import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

/**
 * Accept only inbound request ids that match a small safe character set so
 * we never reflect an attacker-chosen value into log lines or response
 * headers. Alphanumeric plus `-` and `_` between 8 and 128 chars covers
 * UUIDs, ULIDs, and most upstream tracing formats without risk.
 */
const REQUEST_ID_RE = /^[\w-]{8,128}$/;

export interface RequestIdPluginOptions {
  /**
   * Header name to read/write. Defaults to the canonical `x-request-id`.
   */
  header?: string;
}

/**
 * Fastify plugin that propagates a request id across service hops:
 *
 *   1. If the incoming request carries a well-formed X-Request-ID header,
 *      that value becomes `request.id` (and the reply echoes it back).
 *   2. Otherwise Fastify's default id generator runs and the minted id is
 *      echoed on the response.
 *
 * Using fastify-plugin so the hook runs for every route without the
 * consumer having to remember to `register(...)` it inside every scope.
 */
async function requestIdPluginImpl(
  fastify: FastifyInstance,
  opts: RequestIdPluginOptions,
): Promise<void> {
  const headerName = (opts.header ?? 'x-request-id').toLowerCase();

  fastify.addHook('onRequest', async (request, reply) => {
    const raw = request.headers[headerName];
    const candidate = Array.isArray(raw) ? raw[0] : raw;
    if (typeof candidate === 'string' && REQUEST_ID_RE.test(candidate)) {
      // Fastify's request.id is a writable getter when the type of the
      // generator is factory-based; we overwrite via the internal property
      // so Fastify log lines pick it up too.
      (request as unknown as { id: string }).id = candidate;
    }
    reply.header(headerName, request.id);
  });
}

export const requestIdPlugin = fp(requestIdPluginImpl, {
  name: '@bigbluebam/logging/request-id',
  fastify: '5.x',
});
