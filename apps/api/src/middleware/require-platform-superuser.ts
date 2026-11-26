import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Plugin-scoped guard for the SuperUser-only route files (platform,
 * superuser, permissions admin/divergences, deploy settings).
 *
 * The per-route `requireCan(...)` gates on those routes only block when
 * BBB_PERMISSIONS_ENFORCE=on. In the default posture ('off' or 'warn') they
 * let every request through, so this guard is what makes the routes
 * SuperUser-only regardless of that setting.
 *
 * Unlike `requireSuperuser` (require-superuser.ts), this does not require a
 * browser session: SuperUser API keys (used by the MCP platform tools) are
 * allowed, since the auth plugin sets `request.user.is_superuser` the same
 * way for both.
 *
 * Mount it with `fastify.addHook('preHandler', requirePlatformSuperuser)` at
 * the top of an encapsulated (non fastify-plugin) route plugin. Plugin hooks
 * run after the global auth hooks, so `request.user` is already populated.
 */

// Routes that must stay reachable for a non-SuperUser identity.
// stop-impersonation: while impersonating, request.user is the impersonated
// (normal) user. The handler itself checks `request.isImpersonating`, and
// only a SuperUser can start an impersonation session.
const EXEMPT_ROUTES = new Set<string>(['/v1/platform/stop-impersonation']);

export async function requirePlatformSuperuser(request: FastifyRequest, reply: FastifyReply) {
  if (EXEMPT_ROUTES.has(request.routeOptions.url ?? '')) return;

  if (!request.user) {
    return reply.status(401).send({
      error: {
        code: 'UNAUTHORIZED',
        message: 'Authentication required',
        details: [],
        request_id: request.id,
      },
    });
  }

  if (request.user.is_superuser !== true) {
    return reply.status(403).send({
      error: {
        code: 'FORBIDDEN',
        message: 'SuperUser access required',
        details: [],
        request_id: request.id,
      },
    });
  }
}
