/**
 * Log analysis routes for the SuperUser Console.
 *
 *   GET /superuser/system-errors
 *   GET /superuser/activity-log
 *
 * (Distinct from the pre-existing /superuser/audit-log, which surfaces
 *  the SuperUser-only `superuser_audit_log` table. The activity-log
 *  route here is the cross-app stream — every action recorded in any
 *  app, joined into v_activity_unified.)
 *
 * Both are paginated and accept a search query (`q`). The system-errors
 * route reads from the `system_errors` table that every service writes
 * to on 5xx (api) or job failure (worker). The audit-log route reads
 * from `v_activity_unified`, the cross-app activity view.
 */

import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { requireAuth } from '../plugins/auth.js';

const errorsQuery = z.object({
  q: z.string().max(200).optional(),
  service: z.string().max(40).optional(),
  /** ISO timestamp lower bound */
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const auditQuery = z.object({
  q: z.string().max(200).optional(),
  source_app: z.string().max(40).optional(),
  actor_type: z.string().max(20).optional(),
  since: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function requireSuperuser(request: { user: { is_superuser?: boolean } | null }, reply: { status: (n: number) => { send: (b: unknown) => unknown } }, requestId: string) {
  if (!request.user || request.user.is_superuser !== true) {
    return reply.status(403).send({
      error: {
        code: 'FORBIDDEN',
        message: 'SuperUser access required',
        details: [],
        request_id: requestId,
      },
    });
  }
  return null;
}

export default async function superuserLogsRoutes(fastify: FastifyInstance) {
  // ── GET /superuser/system-errors ──────────────────────────────────
  // Returns the most recent 5xx/error rows from across the platform.
  // Both `q` and `service` are AND-combined.
  fastify.get(
    '/superuser/system-errors',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const guard = requireSuperuser(request, reply, request.id);
      if (guard) return guard;

      const parsed = errorsQuery.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid query',
            details: parsed.error.errors.map((e) => ({
              field: e.path.join('.'),
              issue: e.message,
            })),
            request_id: request.id,
          },
        });
      }
      const { q, service, since, limit, offset } = parsed.data;
      const sinceDate = since ? new Date(since) : null;

      // Build the where clause incrementally to keep the SQL readable.
      // Drizzle's `sql` template handles parameter binding so we never
      // interpolate user input directly.
      const conds = [sql`true`];
      if (q) {
        const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
        conds.push(
          sql`(message ILIKE ${pattern} OR coalesce(route, '') ILIKE ${pattern} OR coalesce(error_code, '') ILIKE ${pattern})`,
        );
      }
      if (service) conds.push(sql`service = ${service}`);
      if (sinceDate) conds.push(sql`created_at >= ${sinceDate}`);
      const where = sql.join(conds, sql` AND `);

      const rows = await db.execute(sql`
        SELECT id, service, request_id, method, route, status_code,
               error_code, message, stack, payload, created_at,
               user_id, org_id
        FROM system_errors
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `);
      const countRows = (await db.execute(sql`
        SELECT count(*)::int AS count FROM system_errors WHERE ${where}
      `)) as unknown as Array<{ count: number }>;
      const errCount = countRows[0]?.count ?? 0;

      // Available services + per-service counts so the UI can populate a
      // filter dropdown without a second round trip. Cheap because there
      // are only ~20 distinct services.
      const services = await db.execute(sql`
        SELECT service, count(*)::int AS n
        FROM system_errors
        WHERE created_at > now() - interval '7 days'
        GROUP BY service
        ORDER BY n DESC
      `);

      return reply.send({
        data: {
          rows: Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [],
          total: errCount,
          services: Array.isArray(services)
            ? services
            : (services as { rows?: unknown[] }).rows ?? [],
        },
      });
    },
  );

  // ── GET /superuser/activity-log ───────────────────────────────────
  // Pulls from v_activity_unified — the cross-app activity view.
  fastify.get(
    '/superuser/activity-log',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const guard = requireSuperuser(request, reply, request.id);
      if (guard) return guard;

      const parsed = auditQuery.safeParse(request.query);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid query',
            details: parsed.error.errors.map((e) => ({
              field: e.path.join('.'),
              issue: e.message,
            })),
            request_id: request.id,
          },
        });
      }
      const { q, source_app, actor_type, since, limit, offset } = parsed.data;
      const sinceDate = since ? new Date(since) : null;

      const conds = [sql`true`];
      if (q) {
        const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
        conds.push(
          sql`(action ILIKE ${pattern} OR entity_type ILIKE ${pattern} OR coalesce(source_app, '') ILIKE ${pattern} OR coalesce(details::text, '') ILIKE ${pattern})`,
        );
      }
      if (source_app) conds.push(sql`source_app = ${source_app}`);
      if (actor_type) conds.push(sql`actor_type = ${actor_type}`);
      if (sinceDate) conds.push(sql`created_at >= ${sinceDate}`);
      const where = sql.join(conds, sql` AND `);

      const rows = await db.execute(sql`
        SELECT id, source_app, entity_type, entity_id, project_id,
               organization_id, actor_id, actor_type, action, details,
               created_at
        FROM v_activity_unified
        WHERE ${where}
        ORDER BY created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `);
      const auditCountRows = (await db.execute(sql`
        SELECT count(*)::int AS count FROM v_activity_unified WHERE ${where}
      `)) as unknown as Array<{ count: number }>;
      const auditCount = auditCountRows[0]?.count ?? 0;

      const sources = await db.execute(sql`
        SELECT source_app, count(*)::int AS n
        FROM v_activity_unified
        WHERE created_at > now() - interval '7 days'
        GROUP BY source_app
        ORDER BY n DESC
      `);

      return reply.send({
        data: {
          rows: Array.isArray(rows) ? rows : (rows as { rows?: unknown[] }).rows ?? [],
          total: auditCount,
          sources: Array.isArray(sources)
            ? sources
            : (sources as { rows?: unknown[] }).rows ?? [],
        },
      });
    },
  );
}
