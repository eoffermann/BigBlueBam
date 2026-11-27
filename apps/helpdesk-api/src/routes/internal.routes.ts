/**
 * Internal (service-to-service) Helpdesk routes.
 *
 * POST /helpdesk/internal/tickets (#305): open a ticket on behalf of a requester, for a sibling
 * service that has no helpdesk session to forward. Today: Blank form routing (a public form
 * submission routed to "create a Helpdesk ticket"), which used to POST the session-authenticated
 * customer route with the internal secret and was refused every time.
 *
 * Auth: the suite-wide guard in @bigbluebam/service-health (INTERNAL_SERVICE_SECRET, constant
 * time, fail closed, direct private-network peers only). The org is explicit in the body and the
 * requester is the person who filled the form, found or created as a helpdesk user of that org
 * by email (an existing user's name and verification are never changed). The ticket goes through
 * the same createHelpdeskTicket as the customer route.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { createInternalSecretGuard, internalSecretPreHandler } from '@bigbluebam/service-health';
import { helpdeskInternalTicketCreateSchema } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { env } from '../env.js';
import { helpdeskUsers } from '../db/schema/helpdesk-users.js';
import { upsertHelpdeskUserByEmail } from '../services/user-upsert.service.js';
import { createHelpdeskTicket, ticketResponse } from '../services/ticket-create.service.js';

const requireInternalSecret = internalSecretPreHandler(
  createInternalSecretGuard({ secrets: () => [env.INTERNAL_SERVICE_SECRET] }),
);

export default async function helpdeskInternalRoutes(fastify: FastifyInstance) {
  fastify.post('/helpdesk/internal/tickets', { preHandler: [requireInternalSecret] }, async (request, reply) => {
    const parsed = helpdeskInternalTicketCreateSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Invalid request body',
          details: parsed.error.issues.map((i) => ({ field: i.path.join('.'), issue: i.message })),
          request_id: request.id,
        },
      });
    }
    const body = parsed.data;
    const email = body.requester_email.trim().toLowerCase();

    const [existing] = await db
      .select()
      .from(helpdeskUsers)
      .where(and(eq(helpdeskUsers.org_id, body.org_id), eq(helpdeskUsers.email, email)))
      .limit(1);
    const requester =
      existing ??
      (
        await upsertHelpdeskUserByEmail(
          { email, display_name: body.requester_name?.trim() || email.split('@')[0]! },
          body.org_id,
        )
      ).data;

    try {
      const result = await createHelpdeskTicket(
        {
          requester,
          orgId: body.org_id,
          projectId: null,
          subject: body.subject,
          description: body.description,
          priority: body.priority,
          category: body.category ?? null,
        },
        request.log,
      );
      if (result.kind === 'invalid') {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: result.message, details: [], request_id: request.id },
        });
      }
      if (result.kind === 'deduplicated') {
        return reply.status(200).send({ data: ticketResponse(result.ticket), deduplicated: true });
      }
      return reply.status(201).send({ data: ticketResponse(result.ticket, result.taskId) });
    } catch (err) {
      request.log.error({ err, orgId: body.org_id }, 'internal ticket create failed');
      return reply.status(500).send({
        error: { code: 'INTERNAL_ERROR', message: 'Failed to create ticket', details: [], request_id: request.id },
      });
    }
  });
}
