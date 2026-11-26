import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

/**
 * Guard for api-owned service-to-service routes called by the satellite APIs with the shared
 * INTERNAL_SERVICE_SECRET (header `X-Internal-Service-Secret`, or `X-Internal-Secret`), the same
 * secret and headers internal-can-read accepts. Fails CLOSED when the secret is not configured,
 * and, like requireServiceAuth, refuses a correct secret from outside the private networks so a
 * leaked secret alone is not enough from the internet (nginx does not deny /b3/api/internal/).
 *
 *   401 UNAUTHORIZED  secret not configured, missing or wrong
 *   403 FORBIDDEN     secret right, source address not internal
 */
// IPv4 private ranges, loopback, and IPv6 unique-local (fd00::/8), which Railway's private
// network uses for service-to-service traffic.
const INTERNAL_IP_PREFIXES = ['172.', '10.', '192.168.', '127.', '::1', 'fd', '::ffff:127.', '::ffff:172.', '::ffff:10.', '::ffff:192.168.'];

function sameSecret(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export async function requireInternalServiceSecret(request: FastifyRequest, reply: FastifyReply) {
  const configured = env.INTERNAL_SERVICE_SECRET;
  const deny = (status: number, code: string, message: string) =>
    reply.status(status).send({ error: { code, message, details: [], request_id: request.id } });
  if (!configured) {
    request.log.error('INTERNAL_SERVICE_SECRET is not configured - refusing internal service requests.');
    return deny(401, 'UNAUTHORIZED', 'Internal service authentication is not configured');
  }
  const header = request.headers['x-internal-service-secret'] ?? request.headers['x-internal-secret'];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided || !sameSecret(provided, configured)) {
    return deny(401, 'UNAUTHORIZED', 'Invalid or missing internal service secret');
  }
  if (!INTERNAL_IP_PREFIXES.some((p) => (request.ip ?? '').startsWith(p))) {
    request.log.warn({ ip: request.ip, url: request.url }, 'internal service secret presented from a non-internal address');
    return deny(403, 'FORBIDDEN', 'Internal endpoints are not reachable from this network');
  }
}
