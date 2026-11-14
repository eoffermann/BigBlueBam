/**
 * HB-7: Internal API surface for helpdesk-api → Bam writes.
 *
 * Every endpoint in this file is guarded by requireServiceAuth and is
 * attributed to the HELPDESK_SYSTEM_USER_ID in activity_log. These are
 * the ONLY endpoints helpdesk-api should use when it needs to create or
 * mutate Bam-owned data (tasks, comments, phase transitions). Direct
 * SQL from helpdesk-api to `tasks` / `comments` / `activity_log` is
 * forbidden.
 *
 * Mount prefix: /internal/helpdesk
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { tasks } from '../db/schema/tasks.js';
import { projects } from '../db/schema/projects.js';
import { phases } from '../db/schema/phases.js';
import { labels } from '../db/schema/labels.js';
import { comments } from '../db/schema/comments.js';
import { requireServiceAuth } from '../middleware/require-service-auth.js';
import { requireAuth } from '../plugins/auth.js';
import { HELPDESK_SYSTEM_USER_ID } from '../lib/constants.js';
import { logActivity } from '../services/activity.service.js';
import { env } from '../env.js';

const createTaskSchema = z.object({
  project_id: z.string().uuid(),
  phase_id: z.string().uuid().nullable().optional(),
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  description_plain: z.string().optional(),
  priority: z.enum(['low', 'medium', 'high', 'critical']).default('medium'),
  reporter_id: z.string().uuid().nullable().optional(),
  ticket_id: z.string().uuid(),
  ticket_number: z.number().int().optional(),
  customer_email: z.string().max(320).optional(),
  customer_name: z.string().max(200).optional(),
  customer_id: z.string().optional(),
});

const createCommentSchema = z.object({
  task_id: z.string().uuid(),
  body: z.string().min(1),
  author_label: z.string().max(200).optional(),
  is_system: z.boolean().default(true),
});

export default async function internalHelpdeskRoutes(fastify: FastifyInstance) {
  // ── POST /internal/helpdesk/tasks ───────────────────────────────────────
  // Creates a task on behalf of a helpdesk ticket. Resolves a phase if not
  // provided (prefers is_start=true, then any phase on the project).
  // Applies/creates the "Support Ticket" label. Writes a single
  // activity_log row attributed to HELPDESK_SYSTEM_USER_ID.
  fastify.post(
    '/tasks',
    { preHandler: [requireServiceAuth] },
    async (request, reply) => {
      const data = createTaskSchema.parse(request.body);

      try {
        const result = await db.transaction(async (tx) => {
          const [project] = await tx
            .select()
            .from(projects)
            .where(eq(projects.id, data.project_id))
            .limit(1);

          if (!project) {
            throw new Error('PROJECT_NOT_FOUND');
          }

          // Resolve phase
          let phaseId: string | null = null;
          if (data.phase_id) {
            const [configured] = await tx
              .select({ id: phases.id })
              .from(phases)
              .where(
                and(
                  eq(phases.id, data.phase_id),
                  eq(phases.project_id, project.id),
                ),
              )
              .limit(1);
            if (configured) phaseId = configured.id;
          }
          if (!phaseId) {
            const [startPhase] = await tx
              .select({ id: phases.id })
              .from(phases)
              .where(
                and(eq(phases.project_id, project.id), eq(phases.is_start, true)),
              )
              .orderBy(phases.position)
              .limit(1);
            if (startPhase) phaseId = startPhase.id;
          }
          if (!phaseId) {
            throw new Error('NO_VALID_PHASE');
          }

          // Increment task_id_sequence for human id
          const [updated] = await tx
            .update(projects)
            .set({ task_id_sequence: sql`${projects.task_id_sequence} + 1` })
            .where(eq(projects.id, project.id))
            .returning({ task_id_sequence: projects.task_id_sequence });
          const seq = updated?.task_id_sequence ?? 1;
          const humanId = `${project.task_id_prefix}-${seq}`;

          // Find or create "Support Ticket" label
          let [supportLabel] = await tx
            .select()
            .from(labels)
            .where(
              and(
                eq(labels.project_id, project.id),
                eq(labels.name, 'Support Ticket'),
              ),
            )
            .limit(1);
          if (!supportLabel) {
            [supportLabel] = await tx
              .insert(labels)
              .values({
                project_id: project.id,
                name: 'Support Ticket',
                color: '#6366f1',
                description: 'Ticket submitted via helpdesk portal',
              })
              .returning();
          }
          const labelIds = supportLabel ? [supportLabel.id] : [];

          const customFields: Record<string, unknown> = {
            helpdesk_ticket_id: data.ticket_id,
          };
          if (data.ticket_number !== undefined) {
            customFields.helpdesk_ticket_number = data.ticket_number;
          }
          if (data.customer_email) {
            customFields.helpdesk_customer_email = data.customer_email;
          }
          if (data.customer_id) {
            customFields.helpdesk_customer_id = data.customer_id;
          }
          if (data.customer_name) {
            customFields.helpdesk_customer_name = data.customer_name;
          }

          const [task] = await tx
            .insert(tasks)
            .values({
              project_id: project.id,
              org_id: project.org_id,
              human_id: humanId,
              title: data.title,
              description: data.description ?? null,
              description_plain: data.description_plain ?? null,
              phase_id: phaseId,
              priority: data.priority,
              reporter_id: data.reporter_id ?? null,
              labels: labelIds,
              custom_fields: customFields,
            })
            .returning();

          if (!task) throw new Error('TASK_INSERT_FAILED');

          return { task };
        });

        await logActivity(
          data.project_id,
          HELPDESK_SYSTEM_USER_ID,
          'task.created_from_helpdesk',
          result.task.id,
          {
            ticket_id: data.ticket_id,
            ticket_number: data.ticket_number,
            customer_name: data.customer_name,
            caller: 'helpdesk-api',
          },
        );

        request.log.info(
          { caller: 'helpdesk-api', taskId: result.task.id, ticketId: data.ticket_id },
          'internal-helpdesk: task created',
        );

        return reply.status(201).send({
          data: { id: result.task.id, human_id: result.task.human_id },
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === 'PROJECT_NOT_FOUND') {
          return reply.status(404).send({
            error: { code: 'NOT_FOUND', message: 'Project not found', details: [], request_id: request.id },
          });
        }
        if (message === 'NO_VALID_PHASE') {
          return reply.status(422).send({
            error: {
              code: 'CONFIGURATION_ERROR',
              message: 'Project has no valid phase to place the task in',
              details: [],
              request_id: request.id,
            },
          });
        }
        request.log.error({ err, caller: 'helpdesk-api' }, 'internal-helpdesk: task create failed');
        return reply.status(500).send({
          error: { code: 'INTERNAL_ERROR', message: 'Failed to create task', details: [], request_id: request.id },
        });
      }
    },
  );

  // ── POST /internal/helpdesk/comments ────────────────────────────────────
  // Posts a comment on a task. Always attributed to HELPDESK_SYSTEM_USER_ID
  // (author_id), with optional author_label folded into the body so Bam
  // users can see "John Customer (via helpdesk ticket): ...".
  fastify.post(
    '/comments',
    { preHandler: [requireServiceAuth] },
    async (request, reply) => {
      const data = createCommentSchema.parse(request.body);

      try {
        const [task] = await db
          .select({ id: tasks.id, project_id: tasks.project_id })
          .from(tasks)
          .where(eq(tasks.id, data.task_id))
          .limit(1);

        if (!task) {
          return reply.status(404).send({
            error: { code: 'NOT_FOUND', message: 'Task not found', details: [], request_id: request.id },
          });
        }

        const body = data.author_label
          ? `**${data.author_label}** (via helpdesk ticket):\n\n${data.body}`
          : data.body;

        const [comment] = await db
          .insert(comments)
          .values({
            task_id: data.task_id,
            author_id: HELPDESK_SYSTEM_USER_ID,
            body,
            body_plain: body,
            is_system: data.is_system,
          })
          .returning();

        if (!comment) {
          throw new Error('COMMENT_INSERT_FAILED');
        }

        await db
          .update(tasks)
          .set({
            comment_count: sql`${tasks.comment_count} + 1`,
            updated_at: new Date(),
          })
          .where(eq(tasks.id, data.task_id));

        await logActivity(
          task.project_id,
          HELPDESK_SYSTEM_USER_ID,
          'comment.created_from_helpdesk',
          data.task_id,
          { comment_id: comment.id, author_label: data.author_label ?? null, caller: 'helpdesk-api' },
        );

        request.log.info(
          { caller: 'helpdesk-api', taskId: data.task_id, commentId: comment.id },
          'internal-helpdesk: comment posted',
        );

        return reply.status(201).send({ data: { id: comment.id } });
      } catch (err) {
        request.log.error({ err, caller: 'helpdesk-api' }, 'internal-helpdesk: comment post failed');
        return reply.status(500).send({
          error: { code: 'INTERNAL_ERROR', message: 'Failed to post comment', details: [], request_id: request.id },
        });
      }
    },
  );

  // ── POST /internal/helpdesk/tasks/:id/move-to-terminal-phase ────────────
  // Moves the task to the project's terminal phase (ticket closed).
  fastify.post(
    '/tasks/:id/move-to-terminal-phase',
    { preHandler: [requireServiceAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const [task] = await db
          .select({ id: tasks.id, project_id: tasks.project_id, phase_id: tasks.phase_id })
          .from(tasks)
          .where(eq(tasks.id, id))
          .limit(1);

        if (!task) {
          return reply.status(404).send({
            error: { code: 'NOT_FOUND', message: 'Task not found', details: [], request_id: request.id },
          });
        }

        const [terminalPhase] = await db
          .select({ id: phases.id })
          .from(phases)
          .where(
            and(eq(phases.project_id, task.project_id), eq(phases.is_terminal, true)),
          )
          .orderBy(phases.position)
          .limit(1);

        if (!terminalPhase) {
          return reply.status(422).send({
            error: {
              code: 'CONFIGURATION_ERROR',
              message: 'Project has no terminal phase',
              details: [],
              request_id: request.id,
            },
          });
        }

        await db
          .update(tasks)
          .set({ phase_id: terminalPhase.id, updated_at: new Date() })
          .where(eq(tasks.id, id));

        await logActivity(
          task.project_id,
          HELPDESK_SYSTEM_USER_ID,
          'task.moved_to_terminal_from_helpdesk',
          id,
          { from_phase_id: task.phase_id, to_phase_id: terminalPhase.id, caller: 'helpdesk-api' },
        );

        request.log.info(
          { caller: 'helpdesk-api', taskId: id, phaseId: terminalPhase.id },
          'internal-helpdesk: task moved to terminal phase',
        );

        return reply.send({ data: { id, phase_id: terminalPhase.id } });
      } catch (err) {
        request.log.error({ err, caller: 'helpdesk-api' }, 'internal-helpdesk: move-to-terminal failed');
        return reply.status(500).send({
          error: { code: 'INTERNAL_ERROR', message: 'Failed to move task', details: [], request_id: request.id },
        });
      }
    },
  );

  // ── POST /internal/helpdesk/tasks/:id/reopen ────────────────────────────
  // Moves the task back to the project's first non-terminal phase.
  fastify.post(
    '/tasks/:id/reopen',
    { preHandler: [requireServiceAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      try {
        const [task] = await db
          .select({ id: tasks.id, project_id: tasks.project_id, phase_id: tasks.phase_id })
          .from(tasks)
          .where(eq(tasks.id, id))
          .limit(1);

        if (!task) {
          return reply.status(404).send({
            error: { code: 'NOT_FOUND', message: 'Task not found', details: [], request_id: request.id },
          });
        }

        // Prefer is_start phase; fall back to the first non-terminal phase by position.
        let [targetPhase] = await db
          .select({ id: phases.id })
          .from(phases)
          .where(
            and(eq(phases.project_id, task.project_id), eq(phases.is_start, true)),
          )
          .orderBy(phases.position)
          .limit(1);

        if (!targetPhase) {
          [targetPhase] = await db
            .select({ id: phases.id })
            .from(phases)
            .where(
              and(eq(phases.project_id, task.project_id), eq(phases.is_terminal, false)),
            )
            .orderBy(phases.position)
            .limit(1);
        }

        if (!targetPhase) {
          return reply.status(422).send({
            error: {
              code: 'CONFIGURATION_ERROR',
              message: 'Project has no non-terminal phase to reopen into',
              details: [],
              request_id: request.id,
            },
          });
        }

        await db
          .update(tasks)
          .set({ phase_id: targetPhase.id, updated_at: new Date() })
          .where(eq(tasks.id, id));

        await logActivity(
          task.project_id,
          HELPDESK_SYSTEM_USER_ID,
          'task.reopened_from_helpdesk',
          id,
          { from_phase_id: task.phase_id, to_phase_id: targetPhase.id, caller: 'helpdesk-api' },
        );

        request.log.info(
          { caller: 'helpdesk-api', taskId: id, phaseId: targetPhase.id },
          'internal-helpdesk: task reopened',
        );

        return reply.send({ data: { id, phase_id: targetPhase.id } });
      } catch (err) {
        request.log.error({ err, caller: 'helpdesk-api' }, 'internal-helpdesk: reopen failed');
        return reply.status(500).send({
          error: { code: 'INTERNAL_ERROR', message: 'Failed to reopen task', details: [], request_id: request.id },
        });
      }
    },
  );

  // ── Session-authenticated agent proxies ───────────────────────────────
  // The Bam SPA (task drawer Helpdesk tab, /b3/helpdesk-queue page) reads
  // and answers tickets through these routes. The browser never talks to
  // helpdesk-api's agent surface directly: that surface requires either a
  // per-agent X-Agent-Key or, for these proxies, the shared internal token
  // plus the acting user and org that Bam has already authenticated.
  // Bam is the authority on org membership (requireAuth resolves
  // request.user.org_id to an org the caller belongs to); helpdesk-api
  // still scopes every ticket to that org.
  const ticketParamsSchema = z.object({ id: z.string().uuid() });
  const agentReplySchema = z.object({
    body: z.string().min(1).max(50_000),
    is_internal: z.boolean().default(false),
  });

  fastify.get(
    '/queue',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const qs = request.url.split('?')[1];
      return proxyAgentRequest(request, reply, 'GET', '/helpdesk/agents/agents/queue', {
        query: qs ? new URLSearchParams(qs) : undefined,
      });
    },
  );

  fastify.get(
    '/tickets/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const parsed = ticketParamsSchema.safeParse(request.params);
      if (!parsed.success) return sendNotFound(request, reply);
      return proxyAgentRequest(request, reply, 'GET', `/helpdesk/agents/tickets/${parsed.data.id}`);
    },
  );

  fastify.post(
    '/tickets/:id/messages',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const parsed = ticketParamsSchema.safeParse(request.params);
      if (!parsed.success) return sendNotFound(request, reply);
      const body = agentReplySchema.safeParse(request.body);
      if (!body.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'A non-empty message body is required',
            details: body.error.issues.map((i) => ({ field: i.path.join('.'), issue: i.message })),
            request_id: request.id,
          },
        });
      }
      // Only body + is_internal are forwarded. Authorship comes from the
      // acting-user headers, never from the client.
      return proxyAgentRequest(
        request,
        reply,
        'POST',
        `/helpdesk/agents/tickets/${parsed.data.id}/messages`,
        { body: body.data },
      );
    },
  );
}

function sendNotFound(request: FastifyRequest, reply: FastifyReply) {
  return reply.status(404).send({
    error: { code: 'NOT_FOUND', message: 'Ticket not found', details: [], request_id: request.id },
  });
}

async function proxyAgentRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  method: 'GET' | 'POST',
  path: string,
  opts: { query?: URLSearchParams; body?: unknown } = {},
) {
  const user = request.user;
  if (!user) {
    return reply.status(401).send({
      error: { code: 'UNAUTHORIZED', message: 'Sign in required', details: [], request_id: request.id },
    });
  }
  try {
    const url = new URL(path, env.HELPDESK_API_INTERNAL_URL);
    if (opts.query) {
      for (const [k, v] of opts.query) url.searchParams.set(k, v);
    }

    const headers: Record<string, string> = {
      'x-internal-token': env.INTERNAL_HELPDESK_SECRET,
      'x-acting-user-id': user.id,
      'x-acting-org-id': user.org_id,
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

    const res = await fetch(url.toString(), {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(10000),
    });

    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }

    if (!res.ok) {
      request.log.warn(
        { status: res.status, path, body: text.slice(0, 300) },
        'internal-helpdesk: agent proxy upstream error',
      );
      // Pass through helpdesk-api's own error envelope when it sent one so
      // the UI can show a meaningful message (e.g. "Ticket not found").
      if (json && typeof json === 'object' && 'error' in json) {
        return reply.status(res.status).send(json);
      }
      return reply.status(res.status).send({
        error: {
          code: 'UPSTREAM_ERROR',
          message: `Helpdesk API returned HTTP ${res.status}`,
          details: [],
          request_id: request.id,
        },
      });
    }

    return reply.status(res.status).send(json ?? {});
  } catch (err) {
    request.log.error({ err, path }, 'internal-helpdesk: agent proxy failed');
    return reply.status(502).send({
      error: {
        code: 'UPSTREAM_ERROR',
        message: 'Failed to reach helpdesk API',
        details: [],
        request_id: request.id,
      },
    });
  }
}
