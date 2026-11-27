/**
 * Ticket creation, shared by the customer route (POST /helpdesk/tickets) and the internal route
 * other services use (POST /helpdesk/internal/tickets, #305: Blank form routing). One code path
 * means a Blank-routed ticket gets the same HTML stripping, 1-hour dedupe, project resolution,
 * Bam task, activity row and Bolt event as one a customer files in the portal.
 */
import type { FastifyBaseLogger } from 'fastify';
import { and, asc, desc, eq, gte } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tickets } from '../db/schema/tickets.js';
import { helpdeskSettings } from '../db/schema/helpdesk-settings.js';
import { phases, projects } from '../db/schema/bbb-refs.js';
import { logTicketActivity } from '../lib/ticket-activity.js';
import { broadcastTaskCreated } from '../lib/broadcast.js';
import { bbbClient } from '../lib/bbb-client.js';
import { stripHtml } from '../lib/strip-html.js';
import { publishBoltEvent } from '../lib/bolt-events.js';

type Logger = FastifyBaseLogger;

export interface TicketRequester {
  id: string;
  email: string;
  display_name: string;
}

export interface CreateTicketInput {
  requester: TicketRequester;
  /** The owning org when known (tenant context, or the internal caller's org). */
  orgId: string | null;
  /** An explicit project (per-project portal); otherwise settings / oldest project. */
  projectId: string | null;
  subject: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
  category?: string | null;
}

export type TicketRow = typeof tickets.$inferSelect;

export type CreateTicketResult =
  | { kind: 'invalid'; message: string }
  | { kind: 'deduplicated'; ticket: TicketRow }
  | { kind: 'created'; ticket: TicketRow; taskId: string | null };

/** The ticket shape both routes return. */
export function ticketResponse(ticket: TicketRow, taskId?: string | null) {
  return {
    id: ticket.id,
    ticket_number: ticket.ticket_number,
    subject: ticket.subject,
    description: ticket.description,
    status: ticket.status,
    priority: ticket.priority,
    category: ticket.category,
    task_id: taskId ?? ticket.task_id,
    created_at: ticket.created_at,
    updated_at: ticket.updated_at,
  };
}

/**
 * Create a ticket for `requester`. Throws on a database failure and with message
 * 'NO_VALID_PHASE' when Bam has no start phase (both routes map these to 500s).
 */
export async function createHelpdeskTicket(input: CreateTicketInput, log: Logger): Promise<CreateTicketResult> {
  const { requester: user } = input;

  // HB-19: Sanitize HTML before storing anywhere.
  const safeSubject = stripHtml(input.subject).slice(0, 500);
  const safeDescription = stripHtml(input.description);
  // HB-43: description_plain is the plain-text form of the (potentially rich-text) description.
  const plainDescription = stripHtml(input.description).trim();

  if (!safeSubject || !safeDescription) {
    return { kind: 'invalid', message: 'Subject and description must contain text after HTML is stripped' };
  }

  // HB-8: Idempotency. A recent identical ticket (same requester, subject, description, within
  // the hour) is returned instead of a duplicate.
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const [existingDup] = await db
    .select()
    .from(tickets)
    .where(
      and(
        eq(tickets.helpdesk_user_id, user.id),
        eq(tickets.subject, safeSubject),
        eq(tickets.description, safeDescription),
        gte(tickets.created_at, oneHourAgo),
      ),
    )
    .orderBy(desc(tickets.created_at))
    .limit(1);
  if (existingDup) return { kind: 'deduplicated', ticket: existingDup };

  // D-010: resolve the target project. Precedence: explicit project, then
  // helpdesk_settings.default_project_id for the org, then the org's oldest project (written
  // back to settings). With no org (legacy direct API client) fall back to the first settings row.
  let settings: typeof helpdeskSettings.$inferSelect | undefined;
  if (input.orgId) {
    const rows = await db.select().from(helpdeskSettings).where(eq(helpdeskSettings.org_id, input.orgId)).limit(1);
    settings = rows[0];
  } else {
    // "The first settings row" means the oldest; upload.routes.ts resolves a no-org customer's
    // attachment owner to this same row's org (#334), so both must order the same way.
    const rows = await db
      .select()
      .from(helpdeskSettings)
      .orderBy(asc(helpdeskSettings.created_at), asc(helpdeskSettings.id))
      .limit(1);
    settings = rows[0];
  }

  let projectId: string | null = input.projectId ?? settings?.default_project_id ?? null;

  if (!projectId && input.orgId) {
    const [oldestProject] = await db
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.org_id, input.orgId), eq(projects.is_archived, false)))
      .orderBy(asc(projects.created_at))
      .limit(1);
    if (oldestProject) {
      projectId = oldestProject.id;
      if (settings) {
        await db
          .update(helpdeskSettings)
          .set({ default_project_id: projectId, updated_at: new Date() })
          .where(eq(helpdeskSettings.id, settings.id))
          .catch((err: unknown) => {
            log.warn({ err, orgId: input.orgId, projectId }, 'Failed to persist fallback default_project_id; non-fatal');
          });
      }
    }
  }

  // HB-37: validate the helpdesk-configured phase; if it is gone, let Bam pick a start phase.
  let resolvedPhaseId: string | null = null;
  if (projectId && settings?.default_phase_id) {
    const [configuredPhase] = await db
      .select({ id: phases.id })
      .from(phases)
      .where(and(eq(phases.id, settings.default_phase_id), eq(phases.project_id, projectId)))
      .limit(1);
    if (configuredPhase) resolvedPhaseId = configuredPhase.id;
  }

  // HB-7: persist the ticket standalone, create the Bam task through Bam's internal API, then
  // back-link task_id. A failed task call leaves the ticket unlinked (reconciled later).
  const [ticket] = await db
    .insert(tickets)
    .values({
      helpdesk_user_id: user.id,
      task_id: null,
      project_id: projectId,
      subject: safeSubject,
      description: safeDescription,
      priority: input.priority,
      category: input.category ?? null,
    })
    .returning();
  if (!ticket) throw new Error('TICKET_INSERT_FAILED');

  let taskId: string | null = null;
  if (projectId) {
    try {
      const created = await bbbClient.createTaskFromTicket(
        {
          project_id: projectId,
          phase_id: resolvedPhaseId,
          title: safeSubject,
          description: safeDescription,
          description_plain: plainDescription,
          priority: input.priority,
          ticket_id: ticket.id,
          ticket_number: ticket.ticket_number ?? undefined,
          customer_email: user.email,
          customer_name: user.display_name,
          customer_id: user.id,
        },
        log,
      );
      taskId = created.id;
      await db.update(tickets).set({ task_id: taskId, updated_at: new Date() }).where(eq(tickets.id, ticket.id));
    } catch (bbbErr) {
      const err = bbbErr as Error & { status?: number };
      log.warn(
        { err, status: err.status, ticketId: ticket.id, projectId },
        'Helpdesk ticket created but Bam task creation failed; ticket is unlinked',
      );
    }
  }

  // HB-50 compat: broadcast so Bam boards refresh.
  if (taskId && projectId) {
    await broadcastTaskCreated(projectId, { id: taskId, project_id: projectId });
  }

  // HB-45: audit ticket creation.
  await logTicketActivity({
    ticketId: ticket.id,
    actorType: 'customer',
    actorId: user.id,
    action: 'ticket.created',
    details: { subject: ticket.subject, priority: ticket.priority, category: ticket.category },
    logger: log,
  });

  // G3: Bolt event, org from the linked project. Unlinked tickets skip it (Bolt needs an org).
  if (projectId) {
    const orgIdForEvent =
      (await db.select({ org_id: projects.org_id }).from(projects).where(eq(projects.id, projectId)).limit(1))[0]
        ?.org_id ?? null;
    if (orgIdForEvent) {
      void publishBoltEvent(
        'ticket.created',
        'helpdesk',
        {
          // #289: the nested shape the Bolt catalog, template and seeded rules read
          // (event.ticket.priority, event.ticket.category); the flat keys stay for existing rules.
          ticket: {
            id: ticket.id,
            number: ticket.ticket_number,
            subject: ticket.subject,
            priority: ticket.priority,
            category: ticket.category,
          },
          ticket_id: ticket.id,
          ticket_number: ticket.ticket_number,
          subject: ticket.subject,
          priority: ticket.priority,
          category: ticket.category,
          task_id: taskId,
          helpdesk_user_id: user.id,
          customer_email: user.email,
        },
        orgIdForEvent,
        user.id,
        'user',
      );
    }
  }

  return { kind: 'created', ticket, taskId };
}
