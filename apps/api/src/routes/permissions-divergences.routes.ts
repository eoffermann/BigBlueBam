// Wave B SuperUser dashboard backend.
// Reads permissions_divergence_log + computes the two views the dashboard
// needs: a paginated recent-divergence list and a grouped-by-(permission,
// route) summary with counts.
//
// Both endpoints are SuperUser-only; the table itself is RLS-isolated by
// org_id but SuperUsers run with BYPASSRLS today, so they see everything.

import type { FastifyInstance } from 'fastify';
import { sql, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { permissionsDivergenceLog } from '../db/schema/index.js';
import { requireAuth } from '../plugins/auth.js';
import { requireSuperuser } from '../middleware/require-superuser.js';

export default async function permissionsDivergencesRoutes(fastify: FastifyInstance) {
  // ─── GET /superuser/permissions/divergences/summary ─────────────
  // Returns one row per (permission_id, route_method, route_path) pair,
  // with counts of total observations and divergent observations. The
  // dashboard's main table view.
  fastify.get(
    '/superuser/permissions/divergences/summary',
    { preHandler: [requireAuth, requireSuperuser] },
    async (_request, reply) => {
      const rows = await db
        .select({
          permission_id: permissionsDivergenceLog.permission_id,
          route_method: permissionsDivergenceLog.route_method,
          route_path: permissionsDivergenceLog.route_path,
          observations: sql<number>`count(*)::int`,
          divergences: sql<number>`count(*) FILTER (WHERE ${permissionsDivergenceLog.is_divergent})::int`,
          first_seen: sql<string>`min(${permissionsDivergenceLog.ts})::text`,
          last_seen: sql<string>`max(${permissionsDivergenceLog.ts})::text`,
          sample_reason: sql<string>`(array_agg(${permissionsDivergenceLog.resolved_reason}) FILTER (WHERE ${permissionsDivergenceLog.is_divergent}))[1]`,
        })
        .from(permissionsDivergenceLog)
        .groupBy(
          permissionsDivergenceLog.permission_id,
          permissionsDivergenceLog.route_method,
          permissionsDivergenceLog.route_path,
        )
        .orderBy(desc(sql`count(*) FILTER (WHERE ${permissionsDivergenceLog.is_divergent})`));

      return reply.send({ data: rows });
    },
  );

  // ─── GET /superuser/permissions/divergences ─────────────────────
  // Paginated raw log. The dashboard drills into this view from a
  // summary row to inspect specific request IDs.
  fastify.get<{
    Querystring: {
      permission_id?: string;
      route_path?: string;
      only_divergent?: string;
      limit?: string;
      cursor?: string;
    };
  }>(
    '/superuser/permissions/divergences',
    { preHandler: [requireAuth, requireSuperuser] },
    async (request, reply) => {
      const limit = Math.min(Number(request.query.limit ?? 50), 200);
      const onlyDivergent = request.query.only_divergent === 'true';

      const filters: ReturnType<typeof sql>[] = [];
      if (onlyDivergent) filters.push(sql`${permissionsDivergenceLog.is_divergent}`);
      if (request.query.permission_id) {
        filters.push(sql`${permissionsDivergenceLog.permission_id} = ${request.query.permission_id}`);
      }
      if (request.query.route_path) {
        filters.push(sql`${permissionsDivergenceLog.route_path} = ${request.query.route_path}`);
      }
      if (request.query.cursor) {
        filters.push(sql`${permissionsDivergenceLog.ts} < ${request.query.cursor}`);
      }
      const whereClause = filters.length
        ? sql.join([sql`WHERE`, ...filters.flatMap((f, i) => i === 0 ? [f] : [sql`AND`, f])], sql` `)
        : sql``;

      const rows = await db.execute(sql`
        SELECT id, ts, request_id, user_id, org_id, permission_id,
               scope_type, scope_id, legacy_decision, resolved_decision,
               resolved_reason, route_method, route_path, is_divergent
        FROM permissions_divergence_log
        ${whereClause}
        ORDER BY ts DESC
        LIMIT ${limit + 1}
      `);

      const hasMore = rows.length > limit;
      const data = hasMore ? rows.slice(0, limit) : rows;
      const nextCursor = hasMore ? (data[data.length - 1] as { ts: string }).ts : null;

      return reply.send({ data, next_cursor: nextCursor });
    },
  );
}
