import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { eq, and, isNotNull, isNull, desc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { tasks } from '../db/schema/tasks.js';
import { projects } from '../db/schema/projects.js';
import { apiKeys } from '../db/schema/api-keys.js';
import { users } from '../db/schema/users.js';
import { projectCalendarTokens } from '../db/schema/project-calendar-tokens.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { requireProjectAccess } from '../middleware/authorize.js';
import argon2 from 'argon2';

function escapeIcal(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\n/g, '\\n');
}

function formatIcalDate(dateStr: string): string {
  // date is in YYYY-MM-DD format, return as VALUE=DATE
  return dateStr.replace(/-/g, '');
}

function generateIcal(
  calendarName: string,
  taskList: Array<{
    id: string;
    human_id: string;
    title: string;
    description: string | null;
    due_date: string;
    priority: string;
  }>,
): string {
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BigBlueBam//Tasks//EN',
    `X-WR-CALNAME:${escapeIcal(calendarName)}`,
    'METHOD:PUBLISH',
  ];

  for (const task of taskList) {
    const dueDate = formatIcalDate(task.due_date);
    // Add one day for DTEND (all-day event)
    const d = new Date(task.due_date);
    d.setDate(d.getDate() + 1);
    const endDate = d.toISOString().split('T')[0]!.replace(/-/g, '');

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${task.id}@bigbluebam`);
    lines.push(`DTSTART;VALUE=DATE:${dueDate}`);
    lines.push(`DTEND;VALUE=DATE:${endDate}`);
    lines.push(`SUMMARY:${escapeIcal(`[${task.human_id}] ${task.title}`)}`);
    if (task.description) {
      lines.push(`DESCRIPTION:${escapeIcal(task.description)}`);
    }
    // Map priority: iCal uses 1-9 where 1=highest
    const priorityMap: Record<string, number> = {
      critical: 1,
      high: 3,
      medium: 5,
      low: 7,
    };
    lines.push(`PRIORITY:${priorityMap[task.priority] ?? 5}`);
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

async function fetchProjectTasksIcal(projectId: string): Promise<{
  projectName: string | null;
  body: string | null;
}> {
  const [project] = await db
    .select({ name: projects.name })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!project) return { projectName: null, body: null };

  const taskList = await db
    .select({
      id: tasks.id,
      human_id: tasks.human_id,
      title: tasks.title,
      description: tasks.description,
      due_date: tasks.due_date,
      priority: tasks.priority,
    })
    .from(tasks)
    .where(and(eq(tasks.project_id, projectId), isNotNull(tasks.due_date)));

  const ical = generateIcal(
    `${project.name} - Tasks`,
    taskList
      .filter((t) => t.due_date != null)
      .map((t) => ({ ...t, due_date: t.due_date! })),
  );
  return { projectName: project.name, body: ical };
}

export default async function icalRoutes(fastify: FastifyInstance) {
  // ── GET /projects/:id/calendar.ics ────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/calendar.ics',
    { preHandler: [requireAuth, requireProjectAccess()] },
    async (request, reply) => {
      const projectId = request.params.id;

      const [project] = await db
        .select({ name: projects.name })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);

      if (!project) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Project not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const taskList = await db
        .select({
          id: tasks.id,
          human_id: tasks.human_id,
          title: tasks.title,
          description: tasks.description,
          due_date: tasks.due_date,
          priority: tasks.priority,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.project_id, projectId),
            isNotNull(tasks.due_date),
          ),
        );

      const ical = generateIcal(
        `${project.name} - Tasks`,
        taskList.filter((t) => t.due_date != null).map((t) => ({
          ...t,
          due_date: t.due_date!,
        })),
      );

      return reply
        .header('Content-Type', 'text/calendar; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="calendar.ics"')
        .send(ical);
    },
  );

  // ── GET /me/calendar.ics?token=API_KEY ────────────────────────────────
  fastify.get<{ Querystring: { token?: string } }>(
    '/me/calendar.ics',
    async (request, reply) => {
      // Authenticate via token query parameter or standard auth
      let userId: string | null = null;

      if (request.user) {
        userId = request.user.id;
      } else if (request.query.token) {
        const token = request.query.token;
        const prefix = token.slice(0, 8);

        // #40 sibling: service-account tokens are `bbam_svc_<random>`, so
        // token.slice(0,8) is the literal 'bbam_svc' for every svc key — a
        // degenerate bucket. This path has no DoS cap (it verifies every
        // fetched candidate), so the only risk is the fetch window truncating
        // the bucket and excluding a valid svc key past the 10th row; raise the
        // limit for that known bucket to match the auth-plugin fix. (Mirrors
        // SVC_BUCKET_MAX in plugins/auth.ts; svc tokens as iCal feed tokens are
        // rare, but the root cause is shared.)
        const SVC_KEY_PREFIX = 'bbam_svc';
        const candidates = await db
          .select({
            apiKey: apiKeys,
            user: { id: users.id },
          })
          .from(apiKeys)
          .innerJoin(users, eq(apiKeys.user_id, users.id))
          .where(eq(apiKeys.key_prefix, prefix))
          .limit(prefix === SVC_KEY_PREFIX ? 64 : 10);

        for (const candidate of candidates) {
          if (candidate.apiKey.expires_at && new Date(candidate.apiKey.expires_at) < new Date()) {
            continue;
          }
          try {
            const valid = await argon2.verify(candidate.apiKey.key_hash, token);
            if (valid) {
              userId = candidate.user.id;
              // Update last_used_at
              await db
                .update(apiKeys)
                .set({ last_used_at: new Date() })
                .where(eq(apiKeys.id, candidate.apiKey.id));
              break;
            }
          } catch {
            continue;
          }
        }
      }

      if (!userId) {
        return reply.status(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Authentication required. Provide a valid token query parameter or session.',
            details: [],
            request_id: request.id,
          },
        });
      }

      const taskList = await db
        .select({
          id: tasks.id,
          human_id: tasks.human_id,
          title: tasks.title,
          description: tasks.description,
          due_date: tasks.due_date,
          priority: tasks.priority,
        })
        .from(tasks)
        .where(
          and(
            eq(tasks.assignee_id, userId),
            isNotNull(tasks.due_date),
          ),
        );

      const ical = generateIcal(
        'My Tasks - BigBlueBam',
        taskList.filter((t) => t.due_date != null).map((t) => ({
          ...t,
          due_date: t.due_date!,
        })),
      );

      return reply
        .header('Content-Type', 'text/calendar; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="calendar.ics"')
        .send(ical);
    },
  );

  // ── POST /projects/:id/calendar-tokens ───────────────────────────────
  //
  // Mint a new public calendar token for a project. The plaintext token
  // is returned exactly once — only its argon2 hash is persisted. The
  // associated public URL is `/v1/public/projects/:id/calendar.ics?token=<raw>`,
  // which any external party (no Bam account required) can poll or
  // subscribe to from Google Calendar, Apple Calendar, Outlook, etc.
  fastify.post<{ Params: { id: string }; Body: { name?: string } }>(
    '/projects/:id/calendar-tokens',
    {
      preHandler: [requireAuth, requireScope('read_write'), requireProjectAccess()],
    },
    async (request, reply) => {
      const projectId = request.params.id;
      const schema = z.object({ name: z.string().min(1).max(120).optional() });
      const body = schema.parse(request.body ?? {});

      const [project] = await db
        .select({ id: projects.id, org_id: projects.org_id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);
      if (!project) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Project not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const rawToken = `bbam_cal_${randomBytes(24).toString('base64url')}`;
      const tokenPrefix = rawToken.slice(0, 16);
      const tokenHash = await argon2.hash(rawToken);

      const [row] = await db
        .insert(projectCalendarTokens)
        .values({
          project_id: projectId,
          org_id: project.org_id,
          token_prefix: tokenPrefix,
          token_hash: tokenHash,
          name: body.name ?? 'Project schedule',
          created_by: request.user!.id,
        })
        .returning({
          id: projectCalendarTokens.id,
          name: projectCalendarTokens.name,
          token_prefix: projectCalendarTokens.token_prefix,
          created_at: projectCalendarTokens.created_at,
        });

      return reply.status(201).send({
        data: {
          id: row!.id,
          name: row!.name,
          token: rawToken,
          token_prefix: row!.token_prefix,
          ics_url: `/b3/api/public/projects/${projectId}/calendar.ics?token=${rawToken}`,
          webcal_url: `webcal://__HOST__/b3/api/public/projects/${projectId}/calendar.ics?token=${rawToken}`,
          created_at: row!.created_at,
        },
      });
    },
  );

  // ── GET /projects/:id/calendar-tokens ────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/projects/:id/calendar-tokens',
    { preHandler: [requireAuth, requireProjectAccess()] },
    async (request, reply) => {
      const rows = await db
        .select({
          id: projectCalendarTokens.id,
          name: projectCalendarTokens.name,
          token_prefix: projectCalendarTokens.token_prefix,
          created_at: projectCalendarTokens.created_at,
          last_used_at: projectCalendarTokens.last_used_at,
          revoked_at: projectCalendarTokens.revoked_at,
        })
        .from(projectCalendarTokens)
        .where(eq(projectCalendarTokens.project_id, request.params.id))
        .orderBy(desc(projectCalendarTokens.created_at));
      return reply.send({ data: rows });
    },
  );

  // ── DELETE /projects/:id/calendar-tokens/:tokenId ────────────────────
  fastify.delete<{ Params: { id: string; tokenId: string } }>(
    '/projects/:id/calendar-tokens/:tokenId',
    {
      preHandler: [requireAuth, requireScope('read_write'), requireProjectAccess()],
    },
    async (request, reply) => {
      await db
        .update(projectCalendarTokens)
        .set({ revoked_at: new Date() })
        .where(
          and(
            eq(projectCalendarTokens.id, request.params.tokenId),
            eq(projectCalendarTokens.project_id, request.params.id),
            isNull(projectCalendarTokens.revoked_at),
          ),
        );
      return reply.send({ data: { revoked: true } });
    },
  );

  // ── GET /public/projects/:id/calendar.ics?token=… ────────────────────
  //
  // Public endpoint — anyone holding a non-revoked token gets the .ics.
  // Tokens are scoped to one project; an invalid/revoked/cross-project
  // token returns 401. Argon2-verifies against the candidate row found
  // by token_prefix so we don't pay argon2 cost on every guess.
  fastify.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/public/projects/:id/calendar.ics',
    async (request, reply) => {
      const projectId = request.params.id;
      const raw = request.query.token;
      if (!raw || typeof raw !== 'string' || raw.length < 16) {
        return reply.status(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Missing or malformed token query parameter.',
            details: [],
            request_id: request.id,
          },
        });
      }
      const prefix = raw.slice(0, 16);
      const candidates = await db
        .select()
        .from(projectCalendarTokens)
        .where(
          and(
            eq(projectCalendarTokens.token_prefix, prefix),
            eq(projectCalendarTokens.project_id, projectId),
            isNull(projectCalendarTokens.revoked_at),
          ),
        )
        .limit(10);

      let matched = null as typeof candidates[number] | null;
      for (const c of candidates) {
        try {
          if (await argon2.verify(c.token_hash, raw)) {
            matched = c;
            break;
          }
        } catch {
          continue;
        }
      }
      if (!matched) {
        return reply.status(401).send({
          error: {
            code: 'UNAUTHORIZED',
            message: 'Token is invalid or has been revoked.',
            details: [],
            request_id: request.id,
          },
        });
      }

      await db
        .update(projectCalendarTokens)
        .set({ last_used_at: new Date() })
        .where(eq(projectCalendarTokens.id, matched.id));

      const { projectName, body } = await fetchProjectTasksIcal(projectId);
      if (!body || !projectName) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Project no longer exists.',
            details: [],
            request_id: request.id,
          },
        });
      }
      return reply
        .header('Content-Type', 'text/calendar; charset=utf-8')
        .header('Cache-Control', 'public, max-age=300')
        .header('Content-Disposition', 'inline; filename="project.ics"')
        .send(body);
    },
  );
}
