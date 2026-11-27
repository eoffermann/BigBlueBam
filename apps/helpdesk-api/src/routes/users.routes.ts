// ---------------------------------------------------------------------------
// helpdesk-users admin routes (AGENTIC_TODO §14 Wave 4)
//
// Hosts the POST /v1/helpdesk-users/upsert endpoint used by intake webhooks
// and the `helpdesk_upsert_user` MCP tool. Deliberately kept separate from
// auth.routes.ts (customer self-signup) and agent.routes.ts (ticket-scoped
// operations) because upserts are an admin-surface concern (idempotent
// reconciliation, never the interactive path) and carry a different auth
// contract: they accept the per-agent X-Agent-Key or a Bam session cookie,
// the same way settings.routes.ts does.
// ---------------------------------------------------------------------------

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminAuth } from '../lib/admin-auth.js';
import {
  upsertHelpdeskUserByEmail,
  UserUpsertError,
} from '../services/user-upsert.service.js';
import { publishBoltEvent } from '../lib/bolt-events.js';

const upsertUserSchema = z.object({
  email: z.string().email().max(320),
  display_name: z.string().min(1).max(100),
  password: z.string().min(12).max(256).optional(),
  email_verified: z.boolean().optional(),
  is_active: z.boolean().optional(),
});

export default async function helpdeskUsersRoutes(fastify: FastifyInstance) {
  // POST /v1/helpdesk-users/upsert — idempotent create-or-update by
  // (org_id, email). Security contract: update path NEVER writes the
  // password_hash column, even if `password` is provided. See
  // user-upsert.service.ts for the full rationale.
  fastify.post(
    '/v1/helpdesk-users/upsert',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      preHandler: [requireAdminAuth],
    },
    async (request, reply) => {
      const body = upsertUserSchema.parse(request.body);

      // Resolve org id from X-Org-Slug via the tenant middleware. Without
      // a resolvable org we refuse to write: this upsert is a multi-tenant
      // concern and every row MUST be tagged with a real org_id.
      const orgId = request.tenantContext?.orgId;
      if (!orgId) {
        return reply.status(400).send({
          error: {
            code: 'ORG_REQUIRED',
            message: 'X-Org-Slug header required to resolve org context',
            details: [],
            request_id: request.id,
          },
        });
      }

      try {
        const result = await upsertHelpdeskUserByEmail(body, orgId);

        // Fire-and-forget Bolt event.
        void publishBoltEvent(
          'user.upserted',
          'helpdesk',
          {
            helpdesk_user: {
              id: result.data.id,
              email: result.data.email,
              org_id: result.data.org_id,
              display_name: result.data.display_name,
              email_verified: result.data.email_verified,
              is_active: result.data.is_active,
            },
            created: result.created,
            idempotency_key: result.idempotency_key,
            org: { id: orgId },
          },
          orgId,
          undefined,
          'system',
        );

        return reply.status(result.created ? 201 : 200).send(result);
      } catch (err) {
        if (err instanceof UserUpsertError) {
          return reply.status(err.statusCode).send({
            error: {
              code: err.code,
              message: err.message,
              details: [],
              request_id: request.id,
            },
          });
        }
        throw err;
      }
    },
  );
}
