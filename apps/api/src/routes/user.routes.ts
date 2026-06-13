import type { FastifyInstance } from 'fastify';
import { and, asc, eq, ilike, or, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { users } from '../db/schema/users.js';
import { accountGroupMemberships, permissionGroups } from '../db/schema/permissions.js';
import { requireAuth } from '../plugins/auth.js';
import { shadowOnly } from '../middleware/dual-read.js';

/**
 * Cross-app user resolver endpoints.
 *
 * These endpoints exist so that any MCP tool (Bam, Banter, Bolt, Bond, …) can
 * resolve a user identity from an email or a partial name without having to
 * know which vertical app "owns" the user. The `users` table is shared across
 * every app at the postgres level, so the user id returned here is valid for
 * any other app's `user_id` / `assignee_id` parameter.
 *
 * All endpoints are read-only, org-scoped via `request.user.org_id` (the
 * caller's active organization), and do not expose sensitive columns
 * (`password_hash`, `email_verification_token`, etc.).
 */
export default async function userRoutes(fastify: FastifyInstance) {
  // Shape of the user row we return. Intentionally narrow: only the fields a
  // cross-app resolver needs to identify / display a user. We also expose
  // `name` as an alias for `display_name` so callers that expect a generic
  // "name" column work without additional mapping — the underlying schema
  // only has `display_name`, but both shapes are compatible.
  // Wave E.F: role is resolved via account_group_memberships → permission_groups.
  // Each query inlines a leftJoin scoped to the caller's active org.
  const selectCols = {
    id: users.id,
    email: users.email,
    display_name: users.display_name,
    avatar_url: users.avatar_url,
    role: permissionGroups.legacy_role,
    is_active: users.is_active,
    kind: users.kind,
  } as const;

  type Row = {
    id: string;
    email: string;
    display_name: string;
    avatar_url: string | null;
    role: string | null;
    is_active: boolean;
    kind: 'human' | 'agent' | 'service';
  };

  const shape = (r: Row) => ({
    id: r.id,
    email: r.email,
    // Back-compat alias: many cross-app callers expect a `name` field.
    name: r.display_name,
    display_name: r.display_name,
    avatar_url: r.avatar_url,
    role: r.role ?? 'member',
    is_active: r.is_active,
    kind: r.kind,
  });

  /**
   * GET /users — list users in the caller's active org.
   *
   * Query params:
   *   - active_only (bool, default true): exclude disabled users
   *   - limit (int, default 50, max 200): page size
   *
   * No cursor pagination: this endpoint is intended for resolvers and small
   * pickers. Callers that need full pagination should use `/org/members`.
   */
  fastify.get<{
    Querystring: { active_only?: string; limit?: string };
  }>(
    '/users',
    { preHandler: [requireAuth, shadowOnly('bam.user.list')] },
    async (request, reply) => {
      const activeOnly = request.query.active_only !== 'false'; // default true
      const limit = Math.min(
        Math.max(Number.parseInt(request.query.limit ?? '50', 10) || 50, 1),
        200,
      );

      const conditions = [eq(users.org_id, request.user!.org_id)];
      if (activeOnly) {
        conditions.push(eq(users.is_active, true));
      }

      const rows = await db
        .select(selectCols)
        .from(users)
        .leftJoin(
          accountGroupMemberships,
          and(
            eq(accountGroupMemberships.user_id, users.id),
            eq(accountGroupMemberships.scope_type, 'org'),
            eq(accountGroupMemberships.scope_id, request.user!.org_id),
          ),
        )
        .leftJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
        .where(and(...conditions))
        .orderBy(asc(users.display_name))
        .limit(limit);

      return reply.send({ data: rows.map(shape) });
    },
  );

  /**
   * GET /users/:id — look up a single user by id.
   *
   * Org-scoped: returns 404 if the user is not in the caller's active org.
   * Kept narrow (no password_hash, no verification tokens) for the same
   * reasons as the other resolvers. Used by the MCP confirm_action flow
   * (AGENTIC_TODO §9 Wave 2) to look up the approver's `kind` so the
   * confirmation-token TTL can be adjusted for human vs agent approvers.
   */
  fastify.get<{ Params: { id: string } }>(
    '/users/:id',
    { preHandler: [requireAuth, shadowOnly('bam.user.get')] },
    async (request, reply) => {
      const [row] = await db
        .select(selectCols)
        .from(users)
        .leftJoin(
          accountGroupMemberships,
          and(
            eq(accountGroupMemberships.user_id, users.id),
            eq(accountGroupMemberships.scope_type, 'org'),
            eq(accountGroupMemberships.scope_id, request.user!.org_id),
          ),
        )
        .leftJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
        .where(
          and(
            eq(users.id, request.params.id),
            eq(users.org_id, request.user!.org_id),
          ),
        )
        .limit(1);

      if (!row) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'User not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: shape(row) });
    },
  );

  /**
   * GET /users/by-email?email=... — exact case-insensitive email lookup.
   *
   * Returns { data: null } with HTTP 200 when no user matches, so the caller
   * can handle "not found" without a thrown error. Email uniqueness is
   * enforced at the DB level so at most one row is ever returned.
   */
  fastify.get<{ Querystring: { email?: string } }>(
    '/users/by-email',
    { preHandler: [requireAuth, shadowOnly('bam.user_by_email.list')] },
    async (request, reply) => {
      const email = (request.query.email ?? '').trim();
      if (!email) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'email query parameter is required',
            details: [{ field: 'email', issue: 'required' }],
            request_id: request.id,
          },
        });
      }

      const [row] = await db
        .select(selectCols)
        .from(users)
        .leftJoin(
          accountGroupMemberships,
          and(
            eq(accountGroupMemberships.user_id, users.id),
            eq(accountGroupMemberships.scope_type, 'org'),
            eq(accountGroupMemberships.scope_id, request.user!.org_id),
          ),
        )
        .leftJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
        .where(
          and(
            eq(users.org_id, request.user!.org_id),
            sql`lower(${users.email}) = lower(${email})`,
          ),
        )
        .limit(1);

      return reply.send({ data: row ? shape(row) : null });
    },
  );

  /**
   * GET /users/search?q=... — fuzzy search by display_name or email.
   *
   * Matches are ordered by "relevance" using a simple heuristic:
   *   1. exact email match (case-insensitive)
   *   2. display_name starts-with
   *   3. email starts-with
   *   4. display_name contains
   *   5. email contains
   *
   * Capped at 20 rows. Scoped to the active org. Empty query yields an empty
   * list (not an error — simplifies callers that bind user input directly).
   */
  fastify.get<{ Querystring: { q?: string; limit?: string } }>(
    '/users/search',
    { preHandler: [requireAuth, shadowOnly('bam.user_search.list')] },
    async (request, reply) => {
      const q = (request.query.q ?? '').trim();
      if (!q) {
        return reply.send({ data: [] });
      }

      const limit = Math.min(
        Math.max(Number.parseInt(request.query.limit ?? '20', 10) || 20, 1),
        20,
      );

      const pattern = `%${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;
      const prefix = `${q.replace(/[%_]/g, (m) => `\\${m}`)}%`;

      // Relevance rank: lower number = better match.
      const rank = sql<number>`CASE
        WHEN lower(${users.email}) = lower(${q}) THEN 1
        WHEN ${users.display_name} ILIKE ${prefix} THEN 2
        WHEN ${users.email} ILIKE ${prefix} THEN 3
        WHEN ${users.display_name} ILIKE ${pattern} THEN 4
        WHEN ${users.email} ILIKE ${pattern} THEN 5
        ELSE 6
      END`;

      const rows = await db
        .select({
          ...selectCols,
          rank,
        })
        .from(users)
        .leftJoin(
          accountGroupMemberships,
          and(
            eq(accountGroupMemberships.user_id, users.id),
            eq(accountGroupMemberships.scope_type, 'org'),
            eq(accountGroupMemberships.scope_id, request.user!.org_id),
          ),
        )
        .leftJoin(permissionGroups, eq(permissionGroups.id, accountGroupMemberships.group_id))
        .where(
          and(
            eq(users.org_id, request.user!.org_id),
            eq(users.is_active, true),
            or(
              ilike(users.display_name, pattern),
              ilike(users.email, pattern),
            ),
          ),
        )
        .orderBy(rank, asc(users.display_name))
        .limit(limit);

      return reply.send({ data: rows.map(shape) });
    },
  );
}
