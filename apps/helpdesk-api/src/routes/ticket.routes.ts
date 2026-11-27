import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, asc, desc, gt, lt, or, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tickets } from '../db/schema/tickets.js';
import { ticketMessages } from '../db/schema/ticket-messages.js';
import { ticketActivityLog } from '../db/schema/ticket-activity-log.js';
import { helpdeskTicketEvents } from '../db/schema/ticket-events.js';
import { logTicketActivity } from '../lib/ticket-activity.js';
import { requireHelpdeskAuth } from '../plugins/auth.js';
import { broadcastTicketStatusChanged } from '../lib/broadcast.js';
import { mirrorTicketMessageToTask, mirrorTicketClosedToTask } from '../lib/task-sync.js';
import { bbbClient } from '../lib/bbb-client.js';
import { stripHtml } from '../lib/strip-html.js';
import { publishBoltEvent } from '../lib/bolt-events.js';
import { resolveTicketOrgId } from '../lib/ticket-org.js';
import { createHelpdeskTicket, ticketResponse } from '../services/ticket-create.service.js';
import {
  broadcastTicketMessage,
  broadcastTicketStatusChanged as broadcastTicketStatusChangedRT,
  broadcastTicketUpdated,
} from '../services/realtime.js';

// HB-55: ticket_messages.author_id is NOT NULL and has no FK, so we use the
// nil UUID as the author_id for server-generated "system" messages emitted
// by the duplicate/merge flows. A matching author_name gives the UI
// something sensible to render.
const SYSTEM_AUTHOR_ID = '00000000-0000-0000-0000-000000000000';
const SYSTEM_AUTHOR_NAME = 'System';

const createTicketSchema = z.object({
  subject: z.string().min(1).max(500),
  description: z.string().min(1),
  category: z.string().max(100).optional(),
  priority: z.enum(['low', 'medium', 'high']).default('medium'),
  idempotency_key: z.string().max(200).optional(),
});

const createMessageSchema = z.object({
  body: z.string().min(1),
});


export default async function ticketRoutes(fastify: FastifyInstance) {
  // GET /helpdesk/tickets/search. G5: ranked full-text search across the
  // caller's OWN tickets, using the tickets.search_vector tsvector
  // (subject weighted A, description weighted B) created in migration
  // 0112. Returns up to `limit` rows ordered by ts_rank descending,
  // optionally filtered by status. The query uses plainto_tsquery so
  // user input cannot inject tsquery operators.
  //
  // Registered BEFORE /helpdesk/tickets/:id so the literal /search
  // segment wins Fastify's router match.
  fastify.get(
    '/helpdesk/tickets/search',
    { preHandler: [requireHelpdeskAuth] },
    async (request, reply) => {
      const user = request.helpdeskUser!;
      const query = z
        .object({
          q: z.string().min(1).max(500),
          limit: z.coerce.number().int().min(1).max(50).default(20),
          offset: z.coerce.number().int().min(0).max(500).default(0),
          status: z
            .enum(['open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed'])
            .optional(),
        })
        .parse(request.query ?? {});

      // Cast the user input through plainto_tsquery so tsquery operators
      // in the text are neutralized. ts_rank uses the same tsquery so
      // relevance ordering lines up with the filter.
      const tsQueryExpr = sql`plainto_tsquery('english', ${query.q})`;
      const rankExpr = sql<number>`ts_rank(${tickets.search_vector}, ${tsQueryExpr})`;

      const whereClause = query.status
        ? and(
            eq(tickets.helpdesk_user_id, user.id),
            eq(tickets.status, query.status),
            sql`${tickets.search_vector} @@ ${tsQueryExpr}`,
          )
        : and(
            eq(tickets.helpdesk_user_id, user.id),
            sql`${tickets.search_vector} @@ ${tsQueryExpr}`,
          );

      const rows = await db
        .select({
          id: tickets.id,
          ticket_number: tickets.ticket_number,
          subject: tickets.subject,
          status: tickets.status,
          priority: tickets.priority,
          category: tickets.category,
          created_at: tickets.created_at,
          updated_at: tickets.updated_at,
          rank: rankExpr,
        })
        .from(tickets)
        .where(whereClause)
        .orderBy(sql`${rankExpr} DESC`, desc(tickets.updated_at))
        .limit(query.limit)
        .offset(query.offset);

      return reply.send({
        data: rows,
        query: query.q,
        limit: query.limit,
        offset: query.offset,
      });
    },
  );

  // GET /helpdesk/tickets — list current user's tickets
  fastify.get('/helpdesk/tickets', { preHandler: [requireHelpdeskAuth] }, async (request, reply) => {
    const user = request.helpdeskUser!;

    const rows = await db
      .select({
        id: tickets.id,
        ticket_number: tickets.ticket_number,
        subject: tickets.subject,
        status: tickets.status,
        priority: tickets.priority,
        category: tickets.category,
        created_at: tickets.created_at,
        updated_at: tickets.updated_at,
      })
      .from(tickets)
      .where(eq(tickets.helpdesk_user_id, user.id))
      .orderBy(desc(tickets.updated_at));

    return reply.send({ data: rows });
  });

  // POST /helpdesk/tickets — create ticket. The work is services/ticket-create.service.ts, shared
  // with the internal route other services use (#305).
  fastify.post('/helpdesk/tickets', { preHandler: [requireHelpdeskAuth] }, async (request, reply) => {
    const user = request.helpdeskUser!;
    const data = createTicketSchema.parse(request.body);

    try {
      const result = await createHelpdeskTicket(
        {
          requester: user,
          orgId: request.tenantContext.orgId ?? null,
          projectId: request.tenantContext.projectId ?? null,
          subject: data.subject,
          description: data.description,
          priority: data.priority,
          category: data.category ?? null,
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
      const message = err instanceof Error ? err.message : String(err);
      if (message === 'NO_VALID_PHASE') {
        request.log.error('Helpdesk cannot create task: no valid phase found for project');
        return reply.status(500).send({
          error: {
            code: 'CONFIGURATION_ERROR',
            message: 'Helpdesk project has no start phase configured. Contact your administrator.',
            details: [],
            request_id: request.id,
          },
        });
      }
      request.log.error({ err }, 'Failed to create helpdesk ticket');
      return reply.status(500).send({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Failed to create ticket',
          details: [],
          request_id: request.id,
        },
      });
    }
  });

  // GET /helpdesk/tickets/:id — ticket detail with messages
  fastify.get('/helpdesk/tickets/:id', { preHandler: [requireHelpdeskAuth] }, async (request, reply) => {
    const user = request.helpdeskUser!;
    const { id } = request.params as { id: string };

    const [ticket] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, id), eq(tickets.helpdesk_user_id, user.id)))
      .limit(1);

    if (!ticket) {
      // HB-51: Intentional anti-enumeration. We return 404 (not 403) for BOTH
      // "ticket does not exist" AND "ticket exists but belongs to another
      // customer". Distinguishing these two cases would let an attacker probe
      // for valid ticket UUIDs owned by other users. The authorization filter
      // is baked into the WHERE clause above (helpdesk_user_id = user.id), so
      // any row the caller is not allowed to see is indistinguishable from a
      // nonexistent row from the client's perspective.
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Ticket not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Get messages — exclude internal ones
    const messages = await db
      .select()
      .from(ticketMessages)
      .where(
        and(
          eq(ticketMessages.ticket_id, id),
          eq(ticketMessages.is_internal, false),
        ),
      )
      .orderBy(ticketMessages.created_at);

    // HB-55: expand duplicate/merge relationships for the UI. Two shapes:
    //   - `duplicate_of`: the primary ticket this one points at (if any),
    //     so the customer can see "Duplicate of #123" with a clickable link.
    //   - `duplicates`: the tickets that point at THIS ticket as their
    //     primary (reverse lookup via idx_tickets_duplicate_of). This lets
    //     the primary show "merged from #X, #Y". These are fetched
    //     unconditionally (not ownership-filtered) because the mere
    //     existence of a merged ticket number does not leak sensitive data
    //     and the primary's owner needs to see the full picture.
    let duplicateOfPayload: { id: string; ticket_number: number; subject: string } | null = null;
    if (ticket.duplicate_of) {
      const [primary] = await db
        .select({
          id: tickets.id,
          ticket_number: tickets.ticket_number,
          subject: tickets.subject,
        })
        .from(tickets)
        .where(eq(tickets.id, ticket.duplicate_of))
        .limit(1);
      if (primary && primary.ticket_number !== null) {
        duplicateOfPayload = {
          id: primary.id,
          ticket_number: primary.ticket_number,
          subject: primary.subject,
        };
      }
    }

    const duplicatesRows = await db
      .select({
        id: tickets.id,
        ticket_number: tickets.ticket_number,
        subject: tickets.subject,
        merged_at: tickets.merged_at,
      })
      .from(tickets)
      .where(eq(tickets.duplicate_of, id))
      .orderBy(desc(tickets.merged_at));

    const duplicatesPayload = duplicatesRows
      .filter((r) => r.ticket_number !== null)
      .map((r) => ({
        id: r.id,
        ticket_number: r.ticket_number as number,
        subject: r.subject,
        merged_at: r.merged_at,
      }));

    return reply.send({
      data: {
        ...ticket,
        messages,
        duplicate_of: duplicateOfPayload,
        duplicates: duplicatesPayload,
      },
    });
  });

  // GET /helpdesk/tickets/:id/messages — HB-31: paginated customer-facing
  // message history. Newest-first, cursor-based.
  //
  // Query params:
  //   ?before=<message-uuid>  — return messages strictly older than this one
  //                              (tuple-compare by (created_at, id) DESC)
  //   ?limit=<1..100>          — page size, defaults to 50
  //
  // Response:
  //   { data: TicketMessage[], has_more: boolean, next_before: string | null }
  //
  // Ordering matches the tuple comparison (created_at DESC, id DESC). The
  // cursor is the id of the oldest message in the current page; passing it
  // as ?before= yields the next older page.
  fastify.get(
    '/helpdesk/tickets/:id/messages',
    {
      preHandler: [requireHelpdeskAuth],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const user = request.helpdeskUser!;
      const { id } = request.params as { id: string };
      const query = z
        .object({
          before: z.string().uuid().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
        })
        .parse(request.query ?? {});

      // Ownership check — same as GET /helpdesk/tickets/:id. Returns 404
      // regardless of whether the ticket exists but belongs to another user
      // (HB-51 anti-enumeration).
      const [ticket] = await db
        .select({ id: tickets.id })
        .from(tickets)
        .where(and(eq(tickets.id, id), eq(tickets.helpdesk_user_id, user.id)))
        .limit(1);

      if (!ticket) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Ticket not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Resolve cursor: look up the (created_at, id) of the `before` message.
      // If the cursor refers to a message on another ticket we silently
      // ignore it — it cannot leak anything because we only use its
      // timestamp to filter messages on the current ticket.
      let cursorCreatedAt: Date | null = null;
      let cursorId: string | null = null;
      if (query.before) {
        const [cursorRow] = await db
          .select({ id: ticketMessages.id, created_at: ticketMessages.created_at })
          .from(ticketMessages)
          .where(
            and(
              eq(ticketMessages.id, query.before),
              eq(ticketMessages.ticket_id, id),
            ),
          )
          .limit(1);
        if (cursorRow) {
          cursorCreatedAt = cursorRow.created_at;
          cursorId = cursorRow.id;
        }
      }

      // Fetch limit+1 to determine has_more without a second count query.
      const whereClause = cursorCreatedAt && cursorId
        ? and(
            eq(ticketMessages.ticket_id, id),
            eq(ticketMessages.is_internal, false),
            or(
              lt(ticketMessages.created_at, cursorCreatedAt),
              and(
                eq(ticketMessages.created_at, cursorCreatedAt),
                lt(ticketMessages.id, cursorId),
              ),
            ),
          )
        : and(
            eq(ticketMessages.ticket_id, id),
            eq(ticketMessages.is_internal, false),
          );

      const rows = await db
        .select()
        .from(ticketMessages)
        .where(whereClause)
        .orderBy(desc(ticketMessages.created_at), desc(ticketMessages.id))
        .limit(query.limit + 1);

      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const lastRow = page.length > 0 ? page[page.length - 1] : undefined;
      const nextBefore = hasMore && lastRow ? lastRow.id : null;

      return reply.send({
        data: page,
        has_more: hasMore,
        next_before: nextBefore,
      });
    },
  );

  // POST /helpdesk/tickets/:id/messages — post a message
  fastify.post('/helpdesk/tickets/:id/messages', { preHandler: [requireHelpdeskAuth] }, async (request, reply) => {
    const user = request.helpdeskUser!;
    const { id } = request.params as { id: string };
    const data = createMessageSchema.parse(request.body);

    // Verify ticket belongs to user
    const [ticket] = await db
      .select({ id: tickets.id, status: tickets.status, task_id: tickets.task_id, project_id: tickets.project_id })
      .from(tickets)
      .where(and(eq(tickets.id, id), eq(tickets.helpdesk_user_id, user.id)))
      .limit(1);

    if (!ticket) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Ticket not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    const [message] = await db
      .insert(ticketMessages)
      .values({
        ticket_id: id,
        author_type: 'client',
        author_id: user.id,
        author_name: user.display_name,
        body: stripHtml(data.body),
        is_internal: false,
      })
      .returning();

    if (message) {
      await broadcastTicketMessage(id, {
        id: message.id,
        ticket_id: id,
        body: message.body,
        author_type: 'client',
        author_name: user.display_name,
        created_at: message.created_at,
      });

      // HB-50: Mirror the customer message onto the linked Bam task so the
      // audit trail survives if the ticket is later deleted.
      await mirrorTicketMessageToTask(ticket.task_id, user.display_name, message.body, request.log);

      // HB-45: audit customer reply.
      await logTicketActivity({
        ticketId: id,
        actorType: 'customer',
        actorId: user.id,
        action: 'message.posted',
        details: { message_id: message.id, is_internal: false },
        logger: request.log,
      });

      // G3: ticket.message_posted Bolt event. Fire-and-forget.
      const orgIdForEvent = await resolveTicketOrgId(id);
      if (orgIdForEvent) {
        void publishBoltEvent(
          'ticket.message_posted',
          'helpdesk',
          {
            ticket_id: id,
            message_id: message.id,
            author_type: 'customer',
            helpdesk_user_id: user.id,
            is_internal: false,
          },
          orgIdForEvent,
          user.id,
          'user',
        );
      }
    }

    // HB-15: If the ticket was waiting on the customer, flip it back to open
    // now that the customer has replied, and broadcast the status change.
    if (ticket.status === 'waiting_on_customer') {
      await db
        .update(tickets)
        .set({ status: 'open', updated_at: new Date() })
        .where(eq(tickets.id, id));

      if (ticket.project_id && ticket.task_id) {
        await broadcastTicketStatusChanged(ticket.project_id, ticket.task_id, 'open');
      }
      await broadcastTicketStatusChangedRT(id, 'open');

      // HB-45: audit auto-flip from waiting_on_customer → open driven by
      // the customer's reply. The 'system' actor reflects that this was a
      // server-side reaction, not a manual status change by the customer.
      await logTicketActivity({
        ticketId: id,
        actorType: 'system',
        actorId: null,
        action: 'ticket.status_changed',
        details: { from: 'waiting_on_customer', to: 'open', reason: 'customer_reply' },
        logger: request.log,
      });

      // G3: emit status_changed on the auto-flip as well so Bolt rules
      // that react to status transitions see the system-driven move.
      const autoFlipOrgId = await resolveTicketOrgId(id);
      if (autoFlipOrgId) {
        void publishBoltEvent(
          'ticket.status_changed',
          'helpdesk',
          {
            ticket_id: id,
            from: 'waiting_on_customer',
            to: 'open',
            reason: 'customer_reply',
          },
          autoFlipOrgId,
          undefined,
          'system',
        );
      }
    }

    return reply.status(201).send({ data: message });
  });

  // GET /helpdesk/tickets/:id/activity — HB-45: chronological audit trail
  // for a single ticket. Ownership-guarded: the same 404-everywhere pattern
  // as the other customer-facing ticket routes, so the endpoint cannot be
  // used to enumerate ticket UUIDs owned by other customers.
  //
  // Response: { data: TicketActivity[] } ordered by created_at ASC, capped
  // at 200 rows (tickets with extreme histories would paginate in a future
  // iteration — 200 is comfortably above the expected lifetime per ticket).
  fastify.get(
    '/helpdesk/tickets/:id/activity',
    {
      preHandler: [requireHelpdeskAuth],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const user = request.helpdeskUser!;
      const { id } = request.params as { id: string };

      const [ticket] = await db
        .select({ id: tickets.id })
        .from(tickets)
        .where(and(eq(tickets.id, id), eq(tickets.helpdesk_user_id, user.id)))
        .limit(1);

      if (!ticket) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Ticket not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const rows = await db
        .select({
          id: ticketActivityLog.id,
          ticket_id: ticketActivityLog.ticket_id,
          actor_type: ticketActivityLog.actor_type,
          actor_id: ticketActivityLog.actor_id,
          action: ticketActivityLog.action,
          details: ticketActivityLog.details,
          created_at: ticketActivityLog.created_at,
        })
        .from(ticketActivityLog)
        .where(eq(ticketActivityLog.ticket_id, id))
        .orderBy(asc(ticketActivityLog.created_at))
        .limit(200);

      return reply.send({ data: rows });
    },
  );

  // POST /helpdesk/tickets/:id/reopen — reopen a resolved/closed ticket
  fastify.post('/helpdesk/tickets/:id/reopen', { preHandler: [requireHelpdeskAuth] }, async (request, reply) => {
    const user = request.helpdeskUser!;
    const { id } = request.params as { id: string };

    const [ticket] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, id), eq(tickets.helpdesk_user_id, user.id)))
      .limit(1);

    if (!ticket) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Ticket not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    if (ticket.status !== 'resolved' && ticket.status !== 'closed') {
      return reply.status(400).send({
        error: {
          code: 'INVALID_STATE',
          message: 'Ticket can only be reopened if it is resolved or closed',
          details: [],
          request_id: request.id,
        },
      });
    }

    // HB-4: Include helpdesk_user_id in the UPDATE's WHERE clause so a forged
    // ticket id cannot be reopened under another user's ownership between the
    // SELECT and UPDATE.
    const [updated] = await db
      .update(tickets)
      .set({
        status: 'open',
        resolved_at: null,
        closed_at: null,
      })
      .where(and(eq(tickets.id, id), eq(tickets.helpdesk_user_id, user.id)))
      .returning();

    if (updated) {
      await broadcastTicketStatusChangedRT(id, 'open');

      // HB-45: audit reopen + the corresponding status change.
      await logTicketActivity({
        ticketId: id,
        actorType: 'customer',
        actorId: user.id,
        action: 'ticket.reopened',
        details: { from: ticket.status },
        logger: request.log,
      });
      await logTicketActivity({
        ticketId: id,
        actorType: 'customer',
        actorId: user.id,
        action: 'ticket.status_changed',
        details: { from: ticket.status, to: 'open' },
        logger: request.log,
      });

      // G3: ticket.reopened + ticket.status_changed Bolt events.
      const orgIdForReopen = await resolveTicketOrgId(id);
      if (orgIdForReopen) {
        void publishBoltEvent(
          'ticket.reopened',
          'helpdesk',
          {
            ticket_id: id,
            'ticket.reopened_by': user.id,
            'ticket.reopened_at': new Date().toISOString(),
            from: ticket.status,
          },
          orgIdForReopen,
          user.id,
          'user',
        );
        void publishBoltEvent(
          'ticket.status_changed',
          'helpdesk',
          {
            ticket_id: id,
            from: ticket.status,
            to: 'open',
          },
          orgIdForReopen,
          user.id,
          'user',
        );
      }
    }

    return reply.send({ data: updated });
  });

  // POST /helpdesk/tickets/:id/update-priority — client changes priority
  fastify.post('/helpdesk/tickets/:id/update-priority', { preHandler: [requireHelpdeskAuth] }, async (request, reply) => {
    const user = request.helpdeskUser!;
    const { id } = request.params as { id: string };
    const { priority } = z.object({ priority: z.enum(['low', 'medium', 'high']) }).parse(request.body);

    const [ticket] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, id), eq(tickets.helpdesk_user_id, user.id)))
      .limit(1);

    if (!ticket) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Ticket not found', details: [], request_id: request.id },
      });
    }

    const [updated] = await db
      .update(tickets)
      .set({ priority })
      .where(and(eq(tickets.id, id), eq(tickets.helpdesk_user_id, user.id)))
      .returning();

    if (updated && ticket.priority !== priority) {
      // HB-45: audit customer-driven priority change.
      await logTicketActivity({
        ticketId: id,
        actorType: 'customer',
        actorId: user.id,
        action: 'ticket.priority_changed',
        details: { from: ticket.priority, to: priority },
        logger: request.log,
      });
    }

    return reply.send({ data: updated });
  });

  // POST /helpdesk/tickets/:id/close — client closes their ticket
  fastify.post('/helpdesk/tickets/:id/close', { preHandler: [requireHelpdeskAuth] }, async (request, reply) => {
    const user = request.helpdeskUser!;
    const { id } = request.params as { id: string };

    const [ticket] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, id), eq(tickets.helpdesk_user_id, user.id)))
      .limit(1);

    if (!ticket) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Ticket not found', details: [], request_id: request.id },
      });
    }

    const [updated] = await db
      .update(tickets)
      .set({ status: 'closed', closed_at: new Date() })
      .where(and(eq(tickets.id, id), eq(tickets.helpdesk_user_id, user.id)))
      .returning();

    if (updated) {
      await broadcastTicketStatusChangedRT(id, 'closed');
      // HB-50: Record the closure on the linked Bam task so the trail survives
      // even if the ticket row is later deleted.
      await mirrorTicketClosedToTask(ticket.task_id, user.display_name, request.log);

      // HB-45: audit closure + the corresponding status change.
      await logTicketActivity({
        ticketId: id,
        actorType: 'customer',
        actorId: user.id,
        action: 'ticket.closed',
        details: { from: ticket.status },
        logger: request.log,
      });
      await logTicketActivity({
        ticketId: id,
        actorType: 'customer',
        actorId: user.id,
        action: 'ticket.status_changed',
        details: { from: ticket.status, to: 'closed' },
        logger: request.log,
      });

      // G3: ticket.closed + ticket.status_changed Bolt events.
      const orgIdForClose = await resolveTicketOrgId(id);
      if (orgIdForClose) {
        void publishBoltEvent(
          'ticket.closed',
          'helpdesk',
          {
            ticket_id: id,
            'ticket.closed_by': user.id,
            'ticket.closed_at': new Date().toISOString(),
            from: ticket.status,
          },
          orgIdForClose,
          user.id,
          'user',
        );
        if (ticket.status !== 'closed') {
          void publishBoltEvent(
            'ticket.status_changed',
            'helpdesk',
            {
              ticket_id: id,
              from: ticket.status,
              to: 'closed',
            },
            orgIdForClose,
            user.id,
            'user',
          );
        }
      }
    }

    // HB-16 + HB-7: Move the linked Bam task to a terminal phase via the
    // internal API. Best-effort — don't fail the close.
    if (ticket.task_id && ticket.project_id) {
      try {
        await bbbClient.moveTaskToTerminal(ticket.task_id, request.log);
        await broadcastTicketStatusChanged(ticket.project_id, ticket.task_id, 'closed');
      } catch (err) {
        request.log.warn({ err, ticketId: id }, 'Failed to move linked task to terminal phase');
      }
    }

    return reply.send({ data: updated });
  });

  // GET /helpdesk/tickets/:id/events — HB-47: replay the durable event log
  // for a single ticket. Clients persist the id of the last event they
  // processed and call this on reconnect to catch up on anything they
  // missed while the WebSocket was down.
  //
  // Query params:
  //   ?since=<eventId>  — numeric bigserial id; returns events with id > since
  //   ?limit=<1..500>    — page size, defaults to 100
  //
  // Response:
  //   { data: TicketEvent[], has_more: boolean, latest_id: number | null }
  //
  // Ownership is enforced against tickets.helpdesk_user_id, same 404-
  // everywhere pattern as the other ticket routes (HB-51 anti-enumeration).
  fastify.get(
    '/helpdesk/tickets/:id/events',
    {
      preHandler: [requireHelpdeskAuth],
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const user = request.helpdeskUser!;
      const { id } = request.params as { id: string };
      const query = z
        .object({
          since: z.coerce.number().int().min(0).default(0),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        })
        .parse(request.query ?? {});

      const [ticket] = await db
        .select({ id: tickets.id })
        .from(tickets)
        .where(and(eq(tickets.id, id), eq(tickets.helpdesk_user_id, user.id)))
        .limit(1);

      if (!ticket) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Ticket not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const rows = await db
        .select({
          id: helpdeskTicketEvents.id,
          ticket_id: helpdeskTicketEvents.ticket_id,
          event_type: helpdeskTicketEvents.event_type,
          payload: helpdeskTicketEvents.payload,
          created_at: helpdeskTicketEvents.created_at,
        })
        .from(helpdeskTicketEvents)
        .where(
          and(
            eq(helpdeskTicketEvents.ticket_id, id),
            gt(helpdeskTicketEvents.id, query.since),
          ),
        )
        .orderBy(asc(helpdeskTicketEvents.id))
        .limit(query.limit + 1);

      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const latestId = page.length > 0 ? page[page.length - 1]!.id : null;

      return reply.send({
        data: page,
        has_more: hasMore,
        latest_id: latestId,
      });
    },
  );

  // GET /helpdesk/events — HB-47: replay the durable event log across ALL
  // tickets owned by the caller. The customer portal subscribes to a list
  // of tickets at once (the ticket-list view) and uses this on reconnect
  // to catch up without issuing one request per ticket.
  //
  // Scoped to `ticket_id IN (SELECT id FROM tickets WHERE helpdesk_user_id = :caller)`
  // so a customer can only ever replay events for their own tickets.
  fastify.get(
    '/helpdesk/events',
    {
      preHandler: [requireHelpdeskAuth],
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const user = request.helpdeskUser!;
      const query = z
        .object({
          since: z.coerce.number().int().min(0).default(0),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        })
        .parse(request.query ?? {});

      // Materialize the caller's ticket ids — used both to scope the event
      // query and to short-circuit when the caller has no tickets at all.
      const ownedTickets = await db
        .select({ id: tickets.id })
        .from(tickets)
        .where(eq(tickets.helpdesk_user_id, user.id));

      if (ownedTickets.length === 0) {
        return reply.send({ data: [], has_more: false, latest_id: null });
      }

      const ownedIds = ownedTickets.map((t) => t.id);

      const rows = await db
        .select({
          id: helpdeskTicketEvents.id,
          ticket_id: helpdeskTicketEvents.ticket_id,
          event_type: helpdeskTicketEvents.event_type,
          payload: helpdeskTicketEvents.payload,
          created_at: helpdeskTicketEvents.created_at,
        })
        .from(helpdeskTicketEvents)
        .where(
          and(
            inArray(helpdeskTicketEvents.ticket_id, ownedIds),
            gt(helpdeskTicketEvents.id, query.since),
          ),
        )
        .orderBy(asc(helpdeskTicketEvents.id))
        .limit(query.limit + 1);

      const hasMore = rows.length > query.limit;
      const page = hasMore ? rows.slice(0, query.limit) : rows;
      const latestId = page.length > 0 ? page[page.length - 1]!.id : null;

      return reply.send({
        data: page,
        has_more: hasMore,
        latest_id: latestId,
      });
    },
  );

  // HB-55: POST /helpdesk/tickets/:id/mark-duplicate — customer-side flag
  // marking the current ticket as a duplicate of another one they own.
  // This is purely annotative (no message merge) and sets only
  // `duplicate_of`; `merged_at` / `merged_by` stay NULL. A customer merge
  // (POST /.../messages moved across tickets) is an agent-only action via
  // /agents/tickets/:id/merge.
  //
  // The primary ticket is identified by its human-readable `ticket_number`
  // (what the customer sees in the UI), NOT by uuid — customers should not
  // need to inspect ids. We validate ownership of BOTH the source and the
  // primary so the endpoint cannot be used to enumerate other users'
  // ticket numbers (HB-51 anti-enumeration: we return 404 in both the
  // "primary not found" and "primary owned by someone else" cases).
  fastify.post('/helpdesk/tickets/:id/mark-duplicate', { preHandler: [requireHelpdeskAuth] }, async (request, reply) => {
    const user = request.helpdeskUser!;
    const { id } = request.params as { id: string };
    const body = z
      .object({ primary_ticket_number: z.union([z.string().min(1), z.number().int().positive()]) })
      .parse(request.body ?? {});

    // Normalize: strip a leading '#' and coerce to integer. Reject anything
    // that isn't a positive integer after stripping.
    const raw = String(body.primary_ticket_number).trim().replace(/^#/, '');
    const parsedNumber = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsedNumber) || parsedNumber <= 0 || String(parsedNumber) !== raw) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'primary_ticket_number must be a positive integer',
          details: [{ field: 'primary_ticket_number', issue: 'invalid' }],
          request_id: request.id,
        },
      });
    }

    // Load source (with ownership).
    const [source] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, id), eq(tickets.helpdesk_user_id, user.id)))
      .limit(1);

    if (!source) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Ticket not found', details: [], request_id: request.id },
      });
    }

    // Load primary by ticket_number (with ownership — anti-enumeration).
    const [primary] = await db
      .select()
      .from(tickets)
      .where(
        and(
          eq(tickets.ticket_number, parsedNumber),
          eq(tickets.helpdesk_user_id, user.id),
        ),
      )
      .limit(1);

    if (!primary) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Primary ticket not found', details: [], request_id: request.id },
      });
    }

    if (primary.id === source.id) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'A ticket cannot be a duplicate of itself',
          details: [],
          request_id: request.id,
        },
      });
    }

    // No chains: primary must not itself be a duplicate.
    if (primary.duplicate_of) {
      return reply.status(400).send({
        error: {
          code: 'PRIMARY_IS_DUPLICATE',
          message: 'The specified primary ticket is itself marked as a duplicate. Point at its primary instead.',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Primary must not be closed/archived.
    if (primary.status === 'closed') {
      return reply.status(400).send({
        error: {
          code: 'PRIMARY_CLOSED',
          message: 'The specified primary ticket is closed and cannot accept duplicates.',
          details: [],
          request_id: request.id,
        },
      });
    }

    const [updated] = await db
      .update(tickets)
      .set({ duplicate_of: primary.id, updated_at: new Date() })
      .where(and(eq(tickets.id, source.id), eq(tickets.helpdesk_user_id, user.id)))
      .returning({ id: tickets.id, duplicate_of: tickets.duplicate_of });

    if (!updated) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Ticket not found', details: [], request_id: request.id },
      });
    }

    // System message on the source ticket (customer-visible) recording
    // the annotation. author_id is the nil UUID so this renders as a
    // neutral "System" note rather than attributed to any user.
    await db.insert(ticketMessages).values({
      ticket_id: source.id,
      author_type: 'system',
      author_id: SYSTEM_AUTHOR_ID,
      author_name: SYSTEM_AUTHOR_NAME,
      body: `Marked as duplicate of #${primary.ticket_number} by customer`,
      is_internal: false,
    });

    await broadcastTicketUpdated(source.id, {
      event: 'ticket.marked_duplicate',
      duplicate_of: primary.id,
      primary_number: primary.ticket_number,
    });

    await logTicketActivity({
      ticketId: source.id,
      actorType: 'customer',
      actorId: user.id,
      action: 'ticket.marked_duplicate',
      details: { primary_id: primary.id, primary_number: primary.ticket_number },
      logger: request.log,
    });

    return reply.send({
      data: {
        id: source.id,
        duplicate_of: primary.id,
        primary_number: primary.ticket_number,
      },
    });
  });

  // HB-55: DELETE /helpdesk/tickets/:id/mark-duplicate — customer unmarks
  // their ticket. Clears duplicate_of only; does NOT touch merged_at /
  // merged_by (an agent-merged ticket cannot be un-merged by the customer
  // since the message move has already happened — clearing the flag would
  // desynchronize the primary's conversation from the now-orphan source).
  // So if merged_at IS NOT NULL, we reject with 409.
  fastify.delete('/helpdesk/tickets/:id/mark-duplicate', { preHandler: [requireHelpdeskAuth] }, async (request, reply) => {
    const user = request.helpdeskUser!;
    const { id } = request.params as { id: string };

    const [source] = await db
      .select()
      .from(tickets)
      .where(and(eq(tickets.id, id), eq(tickets.helpdesk_user_id, user.id)))
      .limit(1);

    if (!source) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Ticket not found', details: [], request_id: request.id },
      });
    }

    if (!source.duplicate_of) {
      // Already not a duplicate — idempotent success.
      return reply.send({ data: { id: source.id, duplicate_of: null } });
    }

    if (source.merged_at) {
      return reply.status(409).send({
        error: {
          code: 'CONFLICT',
          message: 'Ticket has been merged by an agent and cannot be unmarked.',
          details: [],
          request_id: request.id,
        },
      });
    }

    await db
      .update(tickets)
      .set({ duplicate_of: null, updated_at: new Date() })
      .where(and(eq(tickets.id, source.id), eq(tickets.helpdesk_user_id, user.id)));

    await db.insert(ticketMessages).values({
      ticket_id: source.id,
      author_type: 'system',
      author_id: SYSTEM_AUTHOR_ID,
      author_name: SYSTEM_AUTHOR_NAME,
      body: 'Duplicate flag cleared by customer',
      is_internal: false,
    });

    await broadcastTicketUpdated(source.id, {
      event: 'ticket.duplicate_cleared',
      duplicate_of: null,
    });

    await logTicketActivity({
      ticketId: source.id,
      actorType: 'customer',
      actorId: user.id,
      action: 'ticket.duplicate_cleared',
      details: { previous_primary_id: source.duplicate_of },
      logger: request.log,
    });

    return reply.send({ data: { id: source.id, duplicate_of: null } });
  });
}
