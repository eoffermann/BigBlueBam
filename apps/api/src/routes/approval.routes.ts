import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '../db/index.js';
import { users } from '../db/schema/users.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';
import { publishBoltEvent } from '../lib/bolt-events.js';

/**
 * POST /v1/approvals  (Wave 4 follow-up)
 *
 * DEPRECATED for new callers. Prefer the durable proposals surface introduced
 * in AGENTIC_TODO §9 Wave 2 (migration 0128):
 *   - POST   /v1/proposals              create a tracked, decidable proposal
 *   - GET    /v1/proposals              list proposals visible to caller
 *   - POST   /v1/proposals/:id/decide   approve / reject / request_revision
 *
 * This endpoint continues to work as a fire-and-forget `approval.requested`
 * event producer (the Banter approval-DM template in apps/bolt-api/src/templates
 * still consumes it). It does NOT persist state, so callers that want a durable
 * inbox entry should migrate to /v1/proposals/*.
 *
 * Minimum-viable approval-request producer. Any app (Brief publish,
 * Bond deal-close sign-off, Bill invoice approval, etc.) can call this
 * route to emit `approval.requested` into Bolt. The Banter approval-DM
 * template (apps/bolt-api/src/templates/banter-approval-dm.ts) consumes
 * the event and sends a DM to the approver.
 *
 * This endpoint intentionally does not persist an `approvals` table row;
 * the consuming Bolt rule (or a follow-up durable-approvals service) is
 * responsible for any state it needs. The goal here is to unblock the
 * existing DM template and give producer apps a single place to fire
 * the event rather than each app learning to call publishBoltEvent.
 *
 * Request body:
 *   {
 *     approver_id:   uuid    // user who should approve
 *     subject_type:  string  // free-form identifier, e.g. 'brief.document', 'bill.invoice'
 *     subject_id:    uuid    // the entity being approved
 *     body:          string  // human-readable prompt for the approver (used as the DM body)
 *     url:           string  // deep link for the approver
 *   }
 *
 * Response: 201 with { event_id: uuid } for traceability.
 */
export default async function approvalRoutes(fastify: FastifyInstance) {
  fastify.post(
    '/v1/approvals',
    { preHandler: [requireAuth, requireScope('read_write'), shadowOnly('bam.approval.create')] },
    async (request, reply) => {
      const schema = z.object({
        approver_id: z.string().uuid(),
        subject_type: z.string().min(1).max(100),
        subject_id: z.string().uuid(),
        body: z.string().min(1).max(10_000),
        url: z.string().max(2000).optional(),
      });

      const body = schema.parse(request.body);
      const user = request.user!;
      const eventId = randomUUID();

      // Look up the approver so the payload includes the display
      // fields the DM template renders. Fetching is best-effort; if
      // the user does not exist we still emit the event with just the
      // id and let downstream consumers decide how to handle it.
      const [approver] = await db
        .select({
          id: users.id,
          display_name: users.display_name,
          email: users.email,
        })
        .from(users)
        .where(eq(users.id, body.approver_id))
        .limit(1);

      const payload = {
        approval_id: eventId,
        subject_id: body.subject_id,
        subject_type: body.subject_type,
        approver: approver
          ? {
              id: approver.id,
              name: approver.display_name,
              email: approver.email,
            }
          : { id: body.approver_id },
        body: body.body,
        url: body.url ?? null,
        requester: { id: user.id },
      };

      await publishBoltEvent(
        'approval.requested',
        'platform',
        payload,
        user.active_org_id,
        user.id,
        'user',
      );

      return reply.status(201).send({
        data: { event_id: eventId },
      });
    },
  );
}
