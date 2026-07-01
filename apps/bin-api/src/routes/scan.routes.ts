import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { getScanOverview, setOrgScanPolicy } from '../services/scan.service.js';

// A caller may set the per-org policy / see override affordances when they are
// a SuperUser or an org owner/admin. Mirrors callerCanOverride in assets.routes.
function callerCanOverride(user: { is_superuser: boolean; role: string } | null): boolean {
  if (!user) return false;
  return user.is_superuser === true || user.role === 'owner' || user.role === 'admin';
}

export default async function scanRoutes(fastify: FastifyInstance) {
  // GET /scan/overview — org-scoped scan progress. Authenticated only; there's
  // nothing private about scan counts, and every user benefits from seeing
  // "N pending / which files errored". Also surfaces the effective policy and
  // whether THIS caller can override (drives admin-only UI affordances).
  fastify.get('/scan/overview', { preHandler: [requireAuth] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const overview = await getScanOverview(request.user!.org_id, callerCanOverride(request.user));
    return reply.send({ data: overview });
  });

  // PUT /scan/policy — set (or clear, with null) the org's "allow work before
  // scan completes" override. Admin/SuperUser only. null falls back to the
  // platform default (system_settings['av.allow_unscanned_access']).
  const policySchema = z.object({ allow_unscanned_access: z.boolean().nullable() });
  fastify.put(
    '/scan/policy',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (!callerCanOverride(request.user)) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Only an org owner/admin or SuperUser may change the scan policy',
            details: [],
            request_id: request.id,
          },
        });
      }
      const body = policySchema.parse(request.body ?? {});
      await setOrgScanPolicy(request.user!.org_id, body.allow_unscanned_access);
      const overview = await getScanOverview(request.user!.org_id, true);
      return reply.send({ data: overview });
    },
  );
}
