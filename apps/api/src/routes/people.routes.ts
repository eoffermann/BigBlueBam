import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import { listScopedPeople } from '../services/people.service.js';

/**
 * People Manager v2 — scoped, permission-graded, multi-org people list
 * (plan §6, milestone M1).
 *
 * External path: `/b3/api/people` (nginx adds the `/b3/api/` prefix; this
 * module registers `/people`). Gated identically to `GET /org/members`
 * (requireAuth + shadowOnly('bam.org_member.list')): visibility is enforced
 * by the membership-union scoping inside the service, not by a role gate
 * (plan §9). Works under BBB_PERMISSIONS_ENFORCE=warn and =on.
 */
export default async function peopleRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/people',
    { preHandler: [requireAuth, shadowOnly('bam.org_member.list')] },
    async (request, reply) => {
      const schema = z.object({
        search: z.string().max(255).optional(),
        is_active: z
          .union([z.literal('true'), z.literal('false')])
          .transform((v) => v === 'true')
          .optional(),
        role: z.enum(['owner', 'admin', 'member', 'viewer', 'guest']).optional(),
        org_id: z.string().uuid().optional(),
        cursor: z.string().max(2048).optional(),
        limit: z.coerce.number().int().positive().max(200).optional(),
      });
      const q = schema.parse(request.query ?? {});

      const result = await listScopedPeople(
        {
          id: request.user!.id,
          isSuperuser: request.user!.is_superuser,
          orgMemberships: request.user!.org_memberships.map((m) => ({
            org_id: m.org_id,
            role: m.role,
          })),
        },
        {
          search: q.search,
          isActive: q.is_active,
          role: q.role,
          orgId: q.org_id,
          cursor: q.cursor,
          limit: q.limit,
        },
      );

      return reply.send({ data: result.data, next_cursor: result.next_cursor });
    },
  );
}
