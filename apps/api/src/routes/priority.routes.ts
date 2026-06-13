/**
 * Per-org task priorities — full CRUD + reorder + transactional
 * delete-with-migrate, mirroring the phase routes' shape. The org
 * priorities table backs every task's `tasks.priority` slug so
 * renaming/recoloring is purely a display-layer change.
 *
 * Routes (all under /b3/api):
 *   GET    /priorities                                 list (org members)
 *   POST   /priorities                                 create (org admin)
 *   PATCH  /priorities/:id                             update (org admin)
 *   DELETE /priorities/:id?migrate_to=<slug>           delete with task migration
 *   POST   /priorities/reorder { ids: [...] }          atomic reorder
 *
 * Permission entries: bam.priority.{list,create,update,delete}. Members
 * always get .list because the priority slug + display name + color is
 * what every task card needs to render itself.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { priorities } from '../db/schema/priorities.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';

const VALUE_RE = /^[a-z0-9][a-z0-9_-]{0,49}$/;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50) || 'priority';
}

const createBody = z.object({
  name: z.string().min(1).max(100),
  /** Optional explicit slug; otherwise derived from name. */
  value: z.string().regex(VALUE_RE).max(50).optional(),
  color: z.string().min(1).max(20),
  icon: z.string().max(50).nullable().optional(),
  position: z.number().int().min(0).optional(),
  is_default: z.boolean().optional(),
});

const updateBody = z.object({
  name: z.string().min(1).max(100).optional(),
  color: z.string().min(1).max(20).optional(),
  icon: z.string().max(50).nullable().optional(),
  position: z.number().int().min(0).optional(),
  is_default: z.boolean().optional(),
});

const reorderBody = z.object({
  ids: z.array(z.string().uuid()).min(1),
});

export default async function priorityRoutes(fastify: FastifyInstance) {
  // GET /priorities — every org member needs the list so task cards can
  // render their colors/labels.
  fastify.get(
    '/priorities',
    {
      preHandler: [requireAuth, shadowOnly('bam.priority.list')],
    },
    async (request, reply) => {
      const rows = await db
        .select()
        .from(priorities)
        .where(eq(priorities.org_id, request.user!.active_org_id))
        .orderBy(asc(priorities.position), asc(priorities.name));
      return reply.send({ data: rows });
    },
  );

  // POST /priorities — admin only.
  fastify.post(
    '/priorities',
    {
      preHandler: [
        requireAuth,
        requireScope('admin'),
        fastify.requireCan('bam.priority.create'),
      ],
    },
    async (request, reply) => {
      const body = createBody.parse(request.body);
      const orgId = request.user!.active_org_id;
      const value = body.value ?? slugify(body.name);

      // Position defaults to (max + 1) so a fresh row sorts last.
      const [maxRow] = await db
        .select({ max: sql<number>`coalesce(max(${priorities.position}), -1)::int` })
        .from(priorities)
        .where(eq(priorities.org_id, orgId));
      const position = body.position ?? (maxRow?.max ?? -1) + 1;

      try {
        const result = await db.transaction(async (tx) => {
          // If setting is_default true, clear it on siblings first.
          if (body.is_default) {
            await tx
              .update(priorities)
              .set({ is_default: false, updated_at: new Date() })
              .where(eq(priorities.org_id, orgId));
          }
          const [inserted] = await tx
            .insert(priorities)
            .values({
              org_id: orgId,
              value,
              name: body.name,
              color: body.color,
              icon: body.icon ?? null,
              position,
              is_default: body.is_default ?? false,
            })
            .returning();
          return inserted;
        });
        return reply.status(201).send({ data: result });
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          return reply.status(409).send({
            error: {
              code: 'CONFLICT',
              message: `A priority with value "${value}" already exists in this org`,
              details: [{ field: 'value', issue: 'already in use' }],
              request_id: request.id,
            },
          });
        }
        throw err;
      }
    },
  );

  // PATCH /priorities/:id — admin only. `value` is intentionally immutable
  // (renaming the slug would orphan every existing task pointed at it).
  fastify.patch<{ Params: { id: string } }>(
    '/priorities/:id',
    {
      preHandler: [
        requireAuth,
        requireScope('admin'),
        fastify.requireCan('bam.priority.update'),
      ],
    },
    async (request, reply) => {
      const body = updateBody.parse(request.body);
      const orgId = request.user!.active_org_id;

      const [existing] = await db
        .select()
        .from(priorities)
        .where(
          and(eq(priorities.id, request.params.id), eq(priorities.org_id, orgId)),
        )
        .limit(1);
      if (!existing) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Priority not found in this org',
            details: [],
            request_id: request.id,
          },
        });
      }

      const result = await db.transaction(async (tx) => {
        if (body.is_default === true && !existing.is_default) {
          await tx
            .update(priorities)
            .set({ is_default: false, updated_at: new Date() })
            .where(eq(priorities.org_id, orgId));
        }
        const updates: Record<string, unknown> = { updated_at: new Date() };
        if (body.name !== undefined) updates.name = body.name;
        if (body.color !== undefined) updates.color = body.color;
        if (body.icon !== undefined) updates.icon = body.icon;
        if (body.position !== undefined) updates.position = body.position;
        if (body.is_default !== undefined) updates.is_default = body.is_default;

        const [updated] = await tx
          .update(priorities)
          .set(updates)
          .where(eq(priorities.id, request.params.id))
          .returning();
        return updated;
      });
      return reply.send({ data: result });
    },
  );

  // DELETE /priorities/:id?migrate_to=<value>
  //   - 409 if tasks reference the value and migrate_to is missing
  //   - 400 if the org has only one priority left (won't delete the last one)
  //   - 400 if deleting the is_default row without changing it first
  fastify.delete<{ Params: { id: string }; Querystring: { migrate_to?: string } }>(
    '/priorities/:id',
    {
      preHandler: [
        requireAuth,
        requireScope('admin'),
        fastify.requireCan('bam.priority.delete'),
      ],
    },
    async (request, reply) => {
      const orgId = request.user!.active_org_id;
      const [target] = await db
        .select()
        .from(priorities)
        .where(
          and(eq(priorities.id, request.params.id), eq(priorities.org_id, orgId)),
        )
        .limit(1);
      if (!target) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Priority not found in this org',
            details: [],
            request_id: request.id,
          },
        });
      }
      if (target.is_default) {
        return reply.status(400).send({
          error: {
            code: 'IS_DEFAULT',
            message: 'Set a different priority as the default before deleting this one',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Refuse to delete the last row.
      const countRows = (await db
        .select({ n: sql<number>`count(*)::int` })
        .from(priorities)
        .where(eq(priorities.org_id, orgId))) as Array<{ n: number }>;
      const n = countRows[0]?.n ?? 0;
      if (n <= 1) {
        return reply.status(400).send({
          error: {
            code: 'LAST_PRIORITY',
            message: 'Cannot delete the only remaining priority',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Count affected tasks (project-scoped via the org_id on projects).
      const taskCountRows = (await db.execute(sql`
        SELECT count(*)::int AS task_count
        FROM tasks t
        JOIN projects p ON p.id = t.project_id
        WHERE p.org_id = ${orgId} AND t.priority = ${target.value}
      `)) as unknown as Array<{ task_count: number }>;
      const task_count = taskCountRows[0]?.task_count ?? 0;

      const migrateTo: string | null = request.query.migrate_to ?? null;
      if (task_count > 0 && !migrateTo) {
        return reply.status(409).send({
          error: {
            code: 'MIGRATION_REQUIRED',
            message: `${task_count} task(s) currently use this priority. Pass ?migrate_to=<value> to redirect them before delete.`,
            details: [{ field: 'migrate_to', issue: `${task_count} tasks affected` }],
            request_id: request.id,
          },
        });
      }
      if (migrateTo) {
        const [destination] = await db
          .select({ value: priorities.value })
          .from(priorities)
          .where(
            and(
              eq(priorities.org_id, orgId),
              eq(priorities.value, migrateTo),
            ),
          )
          .limit(1);
        if (!destination) {
          return reply.status(400).send({
            error: {
              code: 'VALIDATION_ERROR',
              message: `migrate_to value "${migrateTo}" is not a priority in this org`,
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      await db.transaction(async (tx) => {
        if (migrateTo && task_count > 0) {
          await tx.execute(sql`
            UPDATE tasks
               SET priority = ${migrateTo}
              FROM projects
             WHERE tasks.project_id = projects.id
               AND projects.org_id = ${orgId}
               AND tasks.priority = ${target.value}
          `);
        }
        await tx.delete(priorities).where(eq(priorities.id, target.id));
      });

      return reply.send({
        data: { success: true, deleted_id: target.id, tasks_migrated: task_count },
      });
    },
  );

  // POST /priorities/reorder — atomic. Accepts a full ordered id list;
  // anything missing from `ids` is appended in its existing order at
  // the end so a partial submit doesn't drop priorities.
  fastify.post(
    '/priorities/reorder',
    {
      preHandler: [
        requireAuth,
        requireScope('admin'),
        fastify.requireCan('bam.priority.update'),
      ],
    },
    async (request, reply) => {
      const body = reorderBody.parse(request.body);
      const orgId = request.user!.active_org_id;

      const all = await db
        .select({ id: priorities.id })
        .from(priorities)
        .where(eq(priorities.org_id, orgId));
      const allIds = new Set(all.map((r) => r.id));
      // Reject submissions that include foreign ids.
      const bad = body.ids.filter((id) => !allIds.has(id));
      if (bad.length > 0) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Reorder contains ids not in this org',
            details: bad.map((id) => ({ field: 'ids', issue: id })),
            request_id: request.id,
          },
        });
      }
      // Anything missing from `ids` is appended in its existing order.
      const provided = new Set(body.ids);
      const tail = all
        .map((r) => r.id)
        .filter((id) => !provided.has(id));
      const ordered = [...body.ids, ...tail];

      await db.transaction(async (tx) => {
        for (let i = 0; i < ordered.length; i++) {
          await tx
            .update(priorities)
            .set({ position: i, updated_at: new Date() })
            .where(
              and(eq(priorities.id, ordered[i]!), eq(priorities.org_id, orgId)),
            );
        }
      });

      const rows = await db
        .select()
        .from(priorities)
        .where(eq(priorities.org_id, orgId))
        .orderBy(asc(priorities.position));
      return reply.send({ data: rows });
    },
  );
}
