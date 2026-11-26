/**
 * Fastify `trustProxy` from BASTION_TRUST_PROXY_HOPS (spec 5.2).
 *
 * The socket address is always nginx, so the client IP must come from X-Forwarded-For. A
 * naive `trustProxy: true` trusts the LEFTMOST entry, which the client writes itself and can
 * spoof freely. A hop count trusts exactly the proxies we run: compose has one (nginx), Railway
 * two (the edge, then the frontend nginx), and installs behind Cloudflare or Caddy set 2.
 *
 * 0 disables proxy trust (request.ip is the socket address).
 */
export function resolveTrustProxy(hops: number): number | false {
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error(`BASTION_TRUST_PROXY_HOPS must be a whole number of 0 or more, got ${hops}`);
  }
  return hops === 0 ? false : hops;
}
