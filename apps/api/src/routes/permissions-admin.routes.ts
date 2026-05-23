// Wave F SuperUser permissions editor backend.
//
// This file is the shared home for the SuperUser permission admin surface.
// Wave F.1.a (group CRUD), F.1.b (user permission editor), and F.1.c (this
// catalog browse endpoint) all register their routes through this single
// plugin so the prefix and auth wiring stay coherent. Each parallel agent
// adds its own imports and helpers; this initial commit only ships F.1.c.
//
// All endpoints are SuperUser-only via the per-action permissions catalog;
// the resolver enforces SU bypass at step 1, so any non-SU caller hits
// PERMISSION_DENIED before reaching the handler. Until F.1.a's delta
// migration lands the new catalog perms, the resolver returns
// permission_not_in_catalog (fail-open in warn mode), so this endpoint is
// already callable by SU without enforcement gaps.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, eq, gt, inArray, isNull, like, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  INVALIDATION_CHANNELS,
  PERMISSIONS,
  PERMISSIONS_BY_ID,
  resolve as resolvePermission,
} from '@bigbluebam/permissions';
import type {
  AccountGroupMembership,
  AccountPermissionRow,
  PermissionContext,
  PermissionScope,
  ResolveResult,
  ScopeType,
} from '@bigbluebam/permissions';
import { db } from '../db/index.js';
import {
  accountGroupMemberships,
  accountPermissions,
  organizationMemberships,
  permissionGroupDefaults,
  permissionGroups,
  permissions,
  users,
} from '../db/schema/index.js';
import { requireAuth } from '../plugins/auth.js';
import { invalidatePermissionsForUser } from '../services/permissions.service.js';
import { logSuperuserAction } from '../services/superuser-audit.service.js';

// ─────────────────────────────────────────────────────────────────────
// Shared helpers (F.1.b user-permissions section)
// ─────────────────────────────────────────────────────────────────────
const UUID_REGEX_USER =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const scopeTypeEnum = z.enum(['global', 'org', 'project']);

function userValidationError(
  reply: FastifyReply,
  request: FastifyRequest,
  err: z.ZodError,
) {
  return reply.status(400).send({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Invalid request',
      details: err.errors.map((e) => ({
        path: e.path.join('.'),
        message: e.message,
      })),
      request_id: request.id,
    },
  });
}

function userNotFound(
  reply: FastifyReply,
  request: FastifyRequest,
  code: string,
  message: string,
) {
  return reply.status(404).send({
    error: { code, message, details: [], request_id: request.id },
  });
}

function userBadRequest(
  reply: FastifyReply,
  request: FastifyRequest,
  code: string,
  message: string,
) {
  return reply.status(400).send({
    error: { code, message, details: [], request_id: request.id },
  });
}

// Direct in-process cache eviction + Redis pubsub publish so every replica
// drops its cached PermissionContext + matrix entries within milliseconds.
async function invalidateUser(fastify: FastifyInstance, userId: string) {
  try {
    await invalidatePermissionsForUser(userId);
  } catch (err) {
    fastify.log.warn(
      { err, userId },
      'invalidatePermissionsForUser failed (local)',
    );
  }
  try {
    const redis = (
      fastify as unknown as {
        redis?: { publish?: (c: string, m: string) => Promise<number> };
      }
    ).redis;
    if (redis?.publish) {
      await redis.publish(`perms:invalidate:user:${userId}`, '');
    }
  } catch (err) {
    fastify.log.warn({ err, userId }, 'perms:invalidate publish failed');
  }
}

export default async function permissionsAdminRoutes(fastify: FastifyInstance) {
  // ─── Catalog browse section ─────────────────────────────────────
  //
  // GET /superuser/permissions/catalog
  //
  // Lists the per-action permissions catalog with filter support and
  // cursor pagination. The catalog is queried from postgres directly
  // (not the in-memory PERMISSIONS array shipped by @bigbluebam/permissions)
  // so the editor stays consistent with whatever the live DB believes
  // — important because catalog rows arrive via delta migrations that
  // can run independently of the codegen array.
  //
  // Cursor encoding: the natural sort key is `id` (PK, lexicographically
  // ordered as `<app>.<resource>.<verb>`), so we use the raw id as the
  // cursor token. It's already URL-safe and unique. Clients pass it back
  // verbatim.
  fastify.get<{
    Querystring: {
      app?: string;
      resource?: string;
      search?: string;
      is_destructive?: string;
      is_read?: string;
      requires_superuser?: string;
      limit?: string;
      cursor?: string;
    };
  }>(
    '/superuser/permissions/catalog',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.superuser_permission_catalog.list'),
      ],
    },
    async (request, reply) => {
      const q = request.query;

      // Limit: default 200, max 2000. Clamp invalid input rather than
      // 400'ing — keeps the endpoint friendly for ad-hoc curl use.
      let limit = Number(q.limit ?? 200);
      if (!Number.isFinite(limit) || limit <= 0) limit = 200;
      if (limit > 2000) limit = 2000;

      const filters: ReturnType<typeof eq>[] = [];

      if (q.app) {
        filters.push(eq(permissions.app, q.app));
      }
      if (q.resource) {
        filters.push(eq(permissions.resource, q.resource));
      }
      if (q.search) {
        // Substring match on id. Catalog ids are lowercase by convention
        // (`bam.task.create`), so a plain LIKE is fine — escape SQL
        // wildcards in the user input first so a literal `%` doesn't
        // become a wildcard.
        const escaped = q.search.replace(/[\\%_]/g, (c) => `\\${c}`);
        filters.push(like(permissions.id, `%${escaped}%`));
      }
      if (q.is_destructive === 'true') {
        filters.push(eq(permissions.is_destructive, true));
      } else if (q.is_destructive === 'false') {
        filters.push(eq(permissions.is_destructive, false));
      }
      if (q.is_read === 'true') {
        filters.push(eq(permissions.is_read, true));
      } else if (q.is_read === 'false') {
        filters.push(eq(permissions.is_read, false));
      }
      if (q.requires_superuser === 'true') {
        filters.push(eq(permissions.requires_superuser, true));
      } else if (q.requires_superuser === 'false') {
        filters.push(eq(permissions.requires_superuser, false));
      }
      if (q.cursor) {
        filters.push(gt(permissions.id, q.cursor));
      }

      const where =
        filters.length === 0
          ? undefined
          : filters.length === 1
          ? filters[0]
          : and(...filters);

      // Fetch limit+1 rows so we can detect whether another page exists
      // without a separate count query.
      const rows = await db
        .select({
          id: permissions.id,
          app: permissions.app,
          resource: permissions.resource,
          verb: permissions.verb,
          description: permissions.description,
          is_destructive: permissions.is_destructive,
          is_read: permissions.is_read,
          requires_confirmation: permissions.requires_confirmation,
          requires_superuser: permissions.requires_superuser,
        })
        .from(permissions)
        .where(where)
        .orderBy(asc(permissions.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const items = hasMore ? rows.slice(0, limit) : rows;
      const lastItem = items[items.length - 1];
      const nextCursor = hasMore && lastItem ? lastItem.id : null;

      // Total count uses the same filters as the page query (minus the
      // cursor) so pagination UIs can render "X total matches" even when
      // the user is mid-scroll.
      const countFilters = filters.filter((_, i) => {
        // The cursor filter is always last when present; rebuild without it.
        if (!q.cursor) return true;
        return i !== filters.length - 1;
      });
      const countWhere =
        countFilters.length === 0
          ? undefined
          : countFilters.length === 1
          ? countFilters[0]
          : and(...countFilters);
      const countRows = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(permissions)
        .where(countWhere);
      const total = countRows[0]?.total ?? 0;

      return reply.send({
        data: {
          items,
          next_cursor: nextCursor,
          total,
        },
      });
    },
  );

  // ═════════════════════════════════════════════════════════════════
  // Wave F.1.a — group CRUD section
  // ═════════════════════════════════════════════════════════════════
  //
  // Implements §2 of docs/wave-d-audit/wave-f-api-contract.md. Every write
  // wraps in db.transaction and publishes Redis invalidations on
  // perms:invalidate:group:<id> + per-affected-user channels after commit,
  // so every replica drops cached PermissionContexts that join through the
  // edited group within milliseconds.

  // ── GET /superuser/permissions/groups ────────────────────────────
  fastify.get<{
    Querystring: { scope_type?: string; include_deleted?: string };
  }>(
    '/superuser/permissions/groups',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.superuser_permission_group.list'),
      ],
    },
    async (request, reply) => {
      const includeDeleted = request.query.include_deleted === 'true';
      const scopeType = request.query.scope_type;

      const filters: ReturnType<typeof sql>[] = [];
      if (!includeDeleted) filters.push(sql`g.deleted_at IS NULL`);
      if (scopeType) filters.push(sql`g.scope_type = ${scopeType}`);
      const whereClause = filters.length
        ? sql.join(
            [sql`WHERE`, ...filters.flatMap((f, i) => (i === 0 ? [f] : [sql`AND`, f]))],
            sql` `,
          )
        : sql``;

      // Subselects for member/grant/deny counts keep this to one SQL
      // round-trip. member_count counts only live (detached_at IS NULL)
      // memberships so the "can't delete: N members" check downstream is
      // honest about who still resolves through this group's defaults.
      const rows = await db.execute(sql`
        SELECT g.id, g.name, g.description, g.scope_type, g.scope_id,
               g.is_builtin, g.legacy_role, g.created_by,
               g.created_at::text AS created_at,
               g.updated_at::text AS updated_at,
               g.deleted_at::text AS deleted_at,
               (SELECT count(*)::int FROM account_group_memberships m
                  WHERE m.group_id = g.id AND m.detached_at IS NULL) AS member_count,
               (SELECT count(*)::int FROM permission_group_defaults d
                  WHERE d.group_id = g.id AND d.granted = true) AS grant_count,
               (SELECT count(*)::int FROM permission_group_defaults d
                  WHERE d.group_id = g.id AND d.granted = false) AS deny_count
        FROM permission_groups g
        ${whereClause}
        ORDER BY g.is_builtin DESC, g.name ASC
      `);

      return reply.send({ data: rows });
    },
  );

  // ── POST /superuser/permissions/groups ───────────────────────────
  fastify.post(
    '/superuser/permissions/groups',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.superuser_permission_group.create'),
      ],
    },
    async (request, reply) => {
      const parsed = createGroupBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid body',
            details: parsed.error.errors.map((e) => ({
              field: e.path.join('.'),
              issue: e.message,
            })),
            request_id: request.id,
          },
        });
      }
      const body = parsed.data;
      if (body.scope_type === 'global' && body.scope_id) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'scope_id must be null for global scope',
            request_id: request.id,
          },
        });
      }
      if (body.scope_type !== 'global' && !body.scope_id) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: `scope_id required for scope_type=${body.scope_type}`,
            request_id: request.id,
          },
        });
      }

      const userId = (request as unknown as { user?: { id: string } }).user?.id ?? null;

      // Member is the default clone source: matches the spec's "sensible
      // base group" guidance and seeds new custom groups with a workable
      // permission set rather than all-deny.
      const cloneFromId = body.clone_from_group_id ?? MEMBER_GROUP_ID;
      if (body.clone_from_group_id) {
        const [src] = await db
          .select({ id: permissionGroups.id })
          .from(permissionGroups)
          .where(eq(permissionGroups.id, body.clone_from_group_id))
          .limit(1);
        if (!src) {
          return reply.status(422).send({
            error: {
              code: 'NOT_FOUND',
              message: 'clone_from_group_id does not exist',
              request_id: request.id,
            },
          });
        }
      }

      try {
        const created = await db.transaction(async (tx) => {
          const [row] = await tx
            .insert(permissionGroups)
            .values({
              name: body.name,
              description: body.description ?? null,
              scope_type: body.scope_type,
              scope_id: body.scope_id ?? null,
              is_builtin: false,
              legacy_role: null,
              created_by: userId,
            })
            .returning();
          if (!row) throw new Error('insert returned no row');

          // Clone defaults in one SQL statement so a 1k-row catalog clone
          // is a single round-trip rather than 1k inserts.
          await tx.execute(sql`
            INSERT INTO permission_group_defaults (group_id, permission_id, granted)
            SELECT ${row.id}, permission_id, granted
            FROM permission_group_defaults
            WHERE group_id = ${cloneFromId}
            ON CONFLICT (group_id, permission_id) DO NOTHING
          `);

          return row;
        });
        return reply.status(201).send({ data: created });
      } catch (err: unknown) {
        const msg = (err as { message?: string })?.message ?? String(err);
        if (/duplicate key|unique constraint/i.test(msg)) {
          return reply.status(409).send({
            error: {
              code: 'NAME_CONFLICT',
              message: `A group named "${body.name}" already exists at this scope`,
              request_id: request.id,
            },
          });
        }
        fastify.log.error({ err }, 'permissions-admin: group create failed');
        return reply.status(500).send({
          error: { code: 'INTERNAL', message: 'Failed to create group', request_id: request.id },
        });
      }
    },
  );

  // ── GET /superuser/permissions/groups/:id ────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/superuser/permissions/groups/:id',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.superuser_permission_group.get'),
      ],
    },
    async (request, reply) => {
      const { id } = request.params;
      const [group] = await db
        .select()
        .from(permissionGroups)
        .where(eq(permissionGroups.id, id))
        .limit(1);
      if (!group) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Group not found', request_id: request.id },
        });
      }

      const defaultRows = await db
        .select({
          permission_id: permissionGroupDefaults.permission_id,
          granted: permissionGroupDefaults.granted,
        })
        .from(permissionGroupDefaults)
        .where(eq(permissionGroupDefaults.group_id, id));

      // Contract requires EVERY catalog id to be present. Fill missing
      // entries with `false` so the frontend doesn't have to synthesize
      // defaults for newly-added perms that have no group_defaults row yet.
      const defaults: Record<string, boolean> = {};
      const seen = new Set<string>();
      for (const r of defaultRows) {
        defaults[r.permission_id] = r.granted;
        seen.add(r.permission_id);
      }
      for (const meta of PERMISSIONS) {
        if (!seen.has(meta.id)) defaults[meta.id] = false;
      }

      const memberCountRows = (await db.execute(sql`
        SELECT count(*)::int AS member_count
        FROM account_group_memberships
        WHERE group_id = ${id} AND detached_at IS NULL
      `)) as unknown as { member_count: number }[];
      const memberCount = memberCountRows[0]?.member_count ?? 0;

      return reply.send({
        data: {
          group: {
            ...group,
            created_at: (group.created_at as Date).toISOString(),
            updated_at: (group.updated_at as Date).toISOString(),
            deleted_at: group.deleted_at ? (group.deleted_at as Date).toISOString() : null,
          },
          defaults,
          member_count: memberCount,
        },
      });
    },
  );

  // ── PATCH /superuser/permissions/groups/:id ──────────────────────
  fastify.patch<{ Params: { id: string } }>(
    '/superuser/permissions/groups/:id',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.superuser_permission_group.update'),
      ],
    },
    async (request, reply) => {
      const { id } = request.params;
      const parsed = updateGroupBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid body',
            details: parsed.error.errors.map((e) => ({
              field: e.path.join('.'),
              issue: e.message,
            })),
            request_id: request.id,
          },
        });
      }
      const body = parsed.data;

      const [group] = await db
        .select()
        .from(permissionGroups)
        .where(eq(permissionGroups.id, id))
        .limit(1);
      if (!group) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Group not found', request_id: request.id },
        });
      }
      if (group.is_builtin && body.name !== undefined && body.name !== group.name) {
        return reply.status(422).send({
          error: {
            code: 'FORBIDDEN_BUILTIN',
            message: 'Cannot rename a built-in group (legacy_role mapping)',
            request_id: request.id,
          },
        });
      }

      const updates: Record<string, unknown> = { updated_at: new Date() };
      if (body.name !== undefined) updates.name = body.name;
      if (body.description !== undefined) updates.description = body.description;

      try {
        const [updated] = await db
          .update(permissionGroups)
          .set(updates)
          .where(eq(permissionGroups.id, id))
          .returning();
        return reply.send({ data: updated });
      } catch (err: unknown) {
        const msg = (err as { message?: string })?.message ?? String(err);
        if (/duplicate key|unique constraint/i.test(msg)) {
          return reply.status(409).send({
            error: {
              code: 'NAME_CONFLICT',
              message: 'Name already in use at this scope',
              request_id: request.id,
            },
          });
        }
        throw err;
      }
    },
  );

  // ── DELETE /superuser/permissions/groups/:id ─────────────────────
  fastify.delete<{ Params: { id: string } }>(
    '/superuser/permissions/groups/:id',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.superuser_permission_group.delete'),
      ],
    },
    async (request, reply) => {
      const { id } = request.params;
      const [group] = await db
        .select()
        .from(permissionGroups)
        .where(eq(permissionGroups.id, id))
        .limit(1);
      if (!group) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Group not found', request_id: request.id },
        });
      }
      if (group.is_builtin) {
        return reply.status(422).send({
          error: {
            code: 'FORBIDDEN_BUILTIN',
            message: 'Cannot delete a built-in group',
            request_id: request.id,
          },
        });
      }
      if (group.deleted_at) {
        // Idempotent re-delete.
        return reply.send({ data: { id, deleted: true } });
      }

      // 409 if any live memberships remain.
      const liveMembers = await db
        .select({ user_id: accountGroupMemberships.user_id })
        .from(accountGroupMemberships)
        .where(
          and(
            eq(accountGroupMemberships.group_id, id),
            isNull(accountGroupMemberships.detached_at),
          ),
        );
      if (liveMembers.length > 0) {
        return reply.status(409).send({
          error: {
            code: 'GROUP_HAS_MEMBERS',
            message: `Cannot delete: ${liveMembers.length} live member(s) still reference this group`,
            details: [{ member_count: liveMembers.length }],
            request_id: request.id,
          },
        });
      }

      await db
        .update(permissionGroups)
        .set({ deleted_at: new Date(), updated_at: new Date() })
        .where(eq(permissionGroups.id, id));

      // Group-level invalidation. No live members at this point, but
      // stale cached contexts can still reference this group via detached
      // memberships; subscribers drop those entries via TTL.
      await invalidateGroup(fastify, id, []);

      return reply.send({ data: { id, deleted: true } });
    },
  );

  // ── PUT /superuser/permissions/groups/:id/defaults ───────────────
  fastify.put<{ Params: { id: string } }>(
    '/superuser/permissions/groups/:id/defaults',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.superuser_permission_group.set_defaults'),
      ],
    },
    async (request, reply) => {
      const { id } = request.params;
      const parsed = setDefaultsBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Invalid body',
            details: parsed.error.errors.map((e) => ({
              field: e.path.join('.'),
              issue: e.message,
            })),
            request_id: request.id,
          },
        });
      }
      const body = parsed.data;

      const [group] = await db
        .select()
        .from(permissionGroups)
        .where(eq(permissionGroups.id, id))
        .limit(1);
      if (!group) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Group not found', request_id: request.id },
        });
      }

      // Branch 1: reset_to_builtin=true ⇒ delegate to the reset path.
      if (body.reset_to_builtin) {
        return resetGroupDefaults(fastify, request, reply, id);
      }

      // Branch 2: explicit set_true / set_false. Expand globs first.
      const trueExp = expandGlobs(body.set_true ?? []);
      const falseExp = expandGlobs(body.set_false ?? []);

      const unknownIds = [...new Set([...trueExp.unknown, ...falseExp.unknown])];
      if (unknownIds.length > 0) {
        return reply.status(422).send({
          error: {
            code: 'PERMISSION_NOT_IN_CATALOG',
            message: 'One or more permission ids are not in the catalog',
            details: unknownIds.map((permission_id) => ({ permission_id })),
            request_id: request.id,
          },
        });
      }

      // Overlap check after glob expansion.
      const overlap: string[] = [];
      for (const pid of trueExp.ids) if (falseExp.ids.has(pid)) overlap.push(pid);
      if (overlap.length > 0) {
        return reply.status(422).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'set_true and set_false must not overlap after glob expansion',
            details: overlap.map((permission_id) => ({ permission_id })),
            request_id: request.id,
          },
        });
      }

      const trueIds = [...trueExp.ids];
      const falseIds = [...falseExp.ids];
      const allIds = [...trueIds, ...falseIds];

      const summary = await db.transaction(async (tx) => {
        const existing = allIds.length
          ? await tx
              .select({
                permission_id: permissionGroupDefaults.permission_id,
                granted: permissionGroupDefaults.granted,
              })
              .from(permissionGroupDefaults)
              .where(
                and(
                  eq(permissionGroupDefaults.group_id, id),
                  inArray(permissionGroupDefaults.permission_id, allIds),
                ),
              )
          : [];
        const existingMap = new Map(existing.map((e) => [e.permission_id, e.granted]));

        let changed = 0;
        for (const pid of trueIds) if (existingMap.get(pid) !== true) changed++;
        for (const pid of falseIds) if (existingMap.get(pid) !== false) changed++;

        // VALUES-list upsert per polarity: one query per branch rather
        // than one round-trip per row.
        if (trueIds.length > 0) {
          const valuesSql = sql.join(
            trueIds.map((pid) => sql`(${id}::uuid, ${pid}, true)`),
            sql`, `,
          );
          await tx.execute(sql`
            INSERT INTO permission_group_defaults (group_id, permission_id, granted)
            VALUES ${valuesSql}
            ON CONFLICT (group_id, permission_id) DO UPDATE SET granted = EXCLUDED.granted
          `);
        }
        if (falseIds.length > 0) {
          const valuesSql = sql.join(
            falseIds.map((pid) => sql`(${id}::uuid, ${pid}, false)`),
            sql`, `,
          );
          await tx.execute(sql`
            INSERT INTO permission_group_defaults (group_id, permission_id, granted)
            VALUES ${valuesSql}
            ON CONFLICT (group_id, permission_id) DO UPDATE SET granted = EXCLUDED.granted
          `);
        }

        await tx
          .update(permissionGroups)
          .set({ updated_at: new Date() })
          .where(eq(permissionGroups.id, id));

        const nowRows = (await tx.execute(sql`
          SELECT
            (SELECT count(*)::int FROM permission_group_defaults WHERE group_id = ${id} AND granted = true) AS now_granted,
            (SELECT count(*)::int FROM permission_group_defaults WHERE group_id = ${id} AND granted = false) AS now_denied
        `)) as unknown as { now_granted: number; now_denied: number }[];

        return {
          changed,
          now_granted: nowRows[0]?.now_granted ?? 0,
          now_denied: nowRows[0]?.now_denied ?? 0,
        };
      });

      // Fan-out: enumerate live members and publish per-user invalidations.
      const members = await db
        .select({
          user_id: accountGroupMemberships.user_id,
          scope_id: accountGroupMemberships.scope_id,
        })
        .from(accountGroupMemberships)
        .where(
          and(
            eq(accountGroupMemberships.group_id, id),
            isNull(accountGroupMemberships.detached_at),
          ),
        );
      await invalidateGroup(fastify, id, members);

      return reply.send({ data: { group_id: id, ...summary } });
    },
  );

  // ── POST /superuser/permissions/groups/:id/reset ─────────────────
  fastify.post<{ Params: { id: string } }>(
    '/superuser/permissions/groups/:id/reset',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.superuser_permission_group.reset'),
      ],
    },
    async (request, reply) => {
      return resetGroupDefaults(fastify, request, reply, request.params.id);
    },
  );

  // =====================================================================
  // ─── User-permissions section (Wave F.1.b) ───────────────────────────
  // =====================================================================
  //
  // Five endpoints implementing §3 of the Wave F API contract. Each is
  // wrapped in a drizzle transaction so the dual-table writes
  // (memberships + overrides, or override + the detach trigger's
  // snapshot rows) commit atomically. Cache invalidation fires after
  // every successful write: direct in-process eviction via
  // invalidatePermissionsForUser plus a Redis pubsub publish on
  // perms:invalidate:user:<id> so other api replicas drop their cached
  // PermissionContext + matrix entries within milliseconds.

  // ─────────────────────────────────────────────────────────────────
  // GET /superuser/permissions/users/:id
  //
  // Returns { user, memberships, overrides, effective_matrix }.
  // effective_matrix is built by calling the resolver against the
  // user's PermissionContext at the user's primary org scope, for
  // every permission in the static catalog. We load the context ONCE
  // then walk PERMISSIONS in memory; the resolver is a pure function
  // so this is O(catalog_size) CPU with no further DB hits.
  // ─────────────────────────────────────────────────────────────────
  fastify.get<{ Params: { id: string } }>(
    '/superuser/permissions/users/:id',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.superuser_permission_user.get'),
      ],
    },
    async (request, reply) => {
      const userId = request.params.id;
      if (!UUID_REGEX_USER.test(userId)) {
        return userBadRequest(reply, request, 'VALIDATION_ERROR', 'Invalid user id');
      }

      const [userRow] = await db
        .select({
          id: users.id,
          email: users.email,
          display_name: users.display_name,
          is_superuser: users.is_superuser,
          kind: users.kind,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!userRow) {
        return userNotFound(reply, request, 'NOT_FOUND', 'User not found');
      }

      // Resolve the user's primary org. The SuperUser editor needs ONE
      // org scope to compute a comprehensible effective_matrix; we
      // prefer the default org membership and fall back to the first.
      const orgMemberships = await db
        .select({
          org_id: organizationMemberships.org_id,
          is_default: organizationMemberships.is_default,
        })
        .from(organizationMemberships)
        .where(eq(organizationMemberships.user_id, userId));
      const primaryOrgId =
        orgMemberships.find((m) => m.is_default)?.org_id ??
        orgMemberships[0]?.org_id ??
        null;

      // Memberships at every scope (global + org + project) joined
      // with the group's metadata for the dashboard payload.
      const membershipRows = await db
        .select({
          scope_type: accountGroupMemberships.scope_type,
          scope_id: accountGroupMemberships.scope_id,
          detached_at: accountGroupMemberships.detached_at,
          detached_by: accountGroupMemberships.detached_by,
          group_id: permissionGroups.id,
          group_name: permissionGroups.name,
          group_legacy_role: permissionGroups.legacy_role,
          group_is_builtin: permissionGroups.is_builtin,
        })
        .from(accountGroupMemberships)
        .innerJoin(
          permissionGroups,
          eq(permissionGroups.id, accountGroupMemberships.group_id),
        )
        .where(eq(accountGroupMemberships.user_id, userId));

      // Explicit + auto-snapshot overrides at every scope.
      const overrideRows = await db
        .select({
          scope_type: accountPermissions.scope_type,
          scope_id: accountPermissions.scope_id,
          permission_id: accountPermissions.permission_id,
          granted: accountPermissions.granted,
          is_snapshot: accountPermissions.is_snapshot,
          set_by: accountPermissions.set_by,
          set_at: accountPermissions.set_at,
          notes: accountPermissions.notes,
        })
        .from(accountPermissions)
        .where(eq(accountPermissions.user_id, userId));

      // Build the resolver's PermissionContext from the rows just loaded.
      const groupIds = Array.from(
        new Set(membershipRows.map((m) => m.group_id)),
      );
      const defaultRows = groupIds.length
        ? await db
            .select({
              group_id: permissionGroupDefaults.group_id,
              permission_id: permissionGroupDefaults.permission_id,
              granted: permissionGroupDefaults.granted,
            })
            .from(permissionGroupDefaults)
            .where(inArray(permissionGroupDefaults.group_id, groupIds))
        : [];
      const groupDefaults = new Map<string, boolean>();
      for (const d of defaultRows) {
        groupDefaults.set(`${d.group_id}:${d.permission_id}`, d.granted);
      }

      const ctx: PermissionContext = {
        subject: {
          id: userRow.id,
          is_superuser: userRow.is_superuser,
          kind: userRow.kind,
          // Session-equivalent matrix: no api-key ceiling applied.
          api_key_scope: null,
        },
        memberships: membershipRows.map((m): AccountGroupMembership => ({
          group_id: m.group_id,
          scope_type: m.scope_type as ScopeType,
          scope_id: m.scope_id,
          detached_at: m.detached_at?.toISOString() ?? null,
        })),
        account_overrides: overrideRows.map((o): AccountPermissionRow => ({
          scope_type: o.scope_type as ScopeType,
          scope_id: o.scope_id,
          permission_id: o.permission_id,
          granted: o.granted,
          is_snapshot: o.is_snapshot,
        })),
        group_defaults: groupDefaults,
      };

      const scope: PermissionScope = {
        org_id: primaryOrgId,
        project_id: null,
      };

      // Index overrides for set_by/set_at lookup when reason=override.
      const overrideIndex = new Map<
        string,
        (typeof overrideRows)[number]
      >();
      for (const o of overrideRows) {
        const k = `${o.scope_type}:${o.scope_id ?? 'null'}:${o.permission_id}`;
        overrideIndex.set(k, o);
      }

      const effective_matrix: Record<
        string,
        {
          granted: boolean;
          source:
            | 'superuser_bypass'
            | 'group_default'
            | 'override'
            | 'implicit_deny'
            | 'always_permitted_core'
            | 'api_key_ceiling_exceeded'
            | 'requires_superuser'
            | 'agent_disabled'
            | 'agent_tool_not_allowed'
            | 'permission_not_in_catalog';
          group_id?: string;
          set_by?: string;
          set_at?: string;
        }
      > = {};

      for (const meta of PERMISSIONS) {
        const result: ResolveResult = resolvePermission(ctx, meta.id, scope);
        const reason = result.reason;
        const granted = result.decision === 'allow';

        if (reason === 'superuser_bypass') {
          effective_matrix[meta.id] = { granted, source: 'superuser_bypass' };
        } else if (
          reason === 'global_group_default' ||
          reason === 'org_group_default' ||
          reason === 'project_group_default'
        ) {
          effective_matrix[meta.id] = {
            granted,
            source: 'group_default',
            ...(result.group_id ? { group_id: result.group_id } : {}),
          };
        } else if (
          reason === 'global_override' ||
          reason === 'org_override' ||
          reason === 'project_override' ||
          reason === 'global_snapshot' ||
          reason === 'org_snapshot' ||
          reason === 'project_snapshot'
        ) {
          // Surface set_by / set_at from the underlying row.
          const reasonScopeType: ScopeType = reason.startsWith('global')
            ? 'global'
            : reason.startsWith('org')
              ? 'org'
              : 'project';
          const reasonScopeId =
            reasonScopeType === 'global'
              ? null
              : reasonScopeType === 'org'
                ? primaryOrgId
                : null;
          const row = overrideIndex.get(
            `${reasonScopeType}:${reasonScopeId ?? 'null'}:${meta.id}`,
          );
          effective_matrix[meta.id] = {
            granted,
            source: 'override',
            ...(row?.set_by ? { set_by: row.set_by } : {}),
            ...(row?.set_at ? { set_at: row.set_at.toISOString() } : {}),
          };
        } else if (reason === 'implicit_deny') {
          effective_matrix[meta.id] = { granted, source: 'implicit_deny' };
        } else {
          // Catch-all (always_permitted_core, api_key_ceiling_exceeded,
          // requires_superuser, agent_*, permission_not_in_catalog).
          effective_matrix[meta.id] = {
            granted,
            source: reason as 'always_permitted_core',
          };
        }
      }

      return reply.send({
        data: {
          user: {
            id: userRow.id,
            email: userRow.email,
            display_name: userRow.display_name,
            is_superuser: userRow.is_superuser,
            kind: userRow.kind,
            primary_org_id: primaryOrgId,
          },
          memberships: membershipRows.map((m) => ({
            scope_type: m.scope_type,
            scope_id: m.scope_id,
            group: {
              id: m.group_id,
              name: m.group_name,
              legacy_role: m.group_legacy_role,
              is_builtin: m.group_is_builtin,
            },
            detached_at: m.detached_at?.toISOString() ?? null,
            detached_by: m.detached_by ?? null,
          })),
          overrides: overrideRows.map((o) => ({
            scope_type: o.scope_type,
            scope_id: o.scope_id,
            permission_id: o.permission_id,
            granted: o.granted,
            is_snapshot: o.is_snapshot,
            set_by: o.set_by ?? null,
            set_at: o.set_at?.toISOString() ?? null,
            notes: o.notes ?? null,
          })),
          effective_matrix,
        },
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────
  // PUT /superuser/permissions/users/:id/membership
  //
  // Assign a user to a group at a scope (insert if absent, update
  // group_id if present). Re-attaches the membership by resetting
  // detached_at → NULL. Per the contract, this does NOT drop existing
  // account_permissions rows — use POST .../reattach for that.
  // ─────────────────────────────────────────────────────────────────
  fastify.put<{
    Params: { id: string };
    Body: {
      scope_type: 'global' | 'org' | 'project';
      scope_id?: string | null;
      group_id: string;
    };
  }>(
    '/superuser/permissions/users/:id/membership',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.superuser_permission_user.set_membership'),
      ],
    },
    async (request, reply) => {
      const userId = request.params.id;
      if (!UUID_REGEX_USER.test(userId)) {
        return userBadRequest(reply, request, 'VALIDATION_ERROR', 'Invalid user id');
      }

      const bodySchema = z
        .object({
          scope_type: scopeTypeEnum,
          scope_id: z.string().uuid().nullable().optional(),
          group_id: z.string().uuid(),
        })
        .refine(
          (v) =>
            v.scope_type === 'global'
              ? v.scope_id == null
              : typeof v.scope_id === 'string',
          {
            message: 'scope_id is required unless scope_type=global',
            path: ['scope_id'],
          },
        );

      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) return userValidationError(reply, request, parsed.error);
      const { scope_type, group_id } = parsed.data;
      const scope_id = parsed.data.scope_id ?? null;

      const [userRow] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!userRow) {
        return userNotFound(reply, request, 'NOT_FOUND', 'User not found');
      }

      // Verify the group exists, isn't soft-deleted, scope matches.
      const [groupRow] = await db
        .select({
          id: permissionGroups.id,
          scope_type: permissionGroups.scope_type,
          deleted_at: permissionGroups.deleted_at,
        })
        .from(permissionGroups)
        .where(eq(permissionGroups.id, group_id))
        .limit(1);
      if (!groupRow || groupRow.deleted_at != null) {
        return userNotFound(reply, request, 'NOT_FOUND', 'Group not found');
      }
      // A global-scope group (e.g. the built-in Member/Viewer roles) can
      // be attached at any membership scope — that's the pattern Wave B's
      // backfill uses. Otherwise the group's scope_type must match.
      if (groupRow.scope_type !== 'global' && groupRow.scope_type !== scope_type) {
        return reply.status(422).send({
          error: {
            code: 'SCOPE_MISMATCH',
            message: `Group scope_type=${groupRow.scope_type} does not match request scope_type=${scope_type}`,
            details: [],
            request_id: request.id,
          },
        });
      }

      const actor = request.user!;
      let result;
      try {
        result = await db.transaction(async (tx) => {
          // Upsert on PK (user_id, scope_type, scope_id). Drizzle's ON
          // CONFLICT helpers don't cleanly handle composite PKs here,
          // so we do SELECT-then-UPDATE-or-INSERT inside the tx.
          const [existing] = await tx
            .select()
            .from(accountGroupMemberships)
            .where(
              and(
                eq(accountGroupMemberships.user_id, userId),
                eq(accountGroupMemberships.scope_type, scope_type),
                scope_id == null
                  ? isNull(accountGroupMemberships.scope_id)
                  : eq(accountGroupMemberships.scope_id, scope_id),
              ),
            )
            .limit(1);

          if (existing) {
            await tx
              .update(accountGroupMemberships)
              .set({
                group_id,
                detached_at: null,
                detached_by: null,
                granted_by: actor.id,
              })
              .where(
                and(
                  eq(accountGroupMemberships.user_id, userId),
                  eq(accountGroupMemberships.scope_type, scope_type),
                  scope_id == null
                    ? isNull(accountGroupMemberships.scope_id)
                    : eq(accountGroupMemberships.scope_id, scope_id),
                ),
              );
          } else {
            await tx.insert(accountGroupMemberships).values({
              user_id: userId,
              group_id,
              scope_type,
              scope_id,
              detached_at: null,
              granted_by: actor.id,
            });
          }

          const [reread] = await tx
            .select({
              user_id: accountGroupMemberships.user_id,
              group_id: accountGroupMemberships.group_id,
              scope_type: accountGroupMemberships.scope_type,
              scope_id: accountGroupMemberships.scope_id,
              detached_at: accountGroupMemberships.detached_at,
              detached_by: accountGroupMemberships.detached_by,
              granted_by: accountGroupMemberships.granted_by,
              granted_at: accountGroupMemberships.granted_at,
            })
            .from(accountGroupMemberships)
            .where(
              and(
                eq(accountGroupMemberships.user_id, userId),
                eq(accountGroupMemberships.scope_type, scope_type),
                scope_id == null
                  ? isNull(accountGroupMemberships.scope_id)
                  : eq(accountGroupMemberships.scope_id, scope_id),
              ),
            )
            .limit(1);
          return reread;
        });
      } catch (err) {
        request.log.error({ err }, 'permissions-admin: set_membership failed');
        return reply.status(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to set membership',
            details: [],
            request_id: request.id,
          },
        });
      }

      await invalidateUser(fastify, userId);
      await logSuperuserAction({
        superuserId: actor.id,
        action: 'permissions.user.set_membership',
        targetType: 'user',
        targetId: userId,
        details: { scope_type, scope_id, group_id },
        ipAddress: request.ip,
      });

      return reply.send({
        data: {
          membership: {
            user_id: result!.user_id,
            group_id: result!.group_id,
            scope_type: result!.scope_type,
            scope_id: result!.scope_id,
            detached_at: result!.detached_at?.toISOString() ?? null,
            detached_by: result!.detached_by ?? null,
            granted_by: result!.granted_by ?? null,
            granted_at: result!.granted_at?.toISOString() ?? null,
          },
        },
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────
  // PUT /superuser/permissions/users/:id/overrides/:permission_id
  //
  // Insert (or replace) an explicit override row. The
  // account_permissions_detach_trigger fires automatically on the
  // first explicit override at a scope: it snapshots every group
  // default into account_permissions (is_snapshot=true) and stamps
  // detached_at on the membership. We don't duplicate that work.
  // ─────────────────────────────────────────────────────────────────
  fastify.put<{
    Params: { id: string; permission_id: string };
    Body: {
      scope_type: 'global' | 'org' | 'project';
      scope_id?: string | null;
      granted: boolean;
      notes?: string | null;
    };
  }>(
    '/superuser/permissions/users/:id/overrides/:permission_id',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.superuser_permission_user.set_override'),
      ],
    },
    async (request, reply) => {
      const userId = request.params.id;
      const permissionId = request.params.permission_id;
      if (!UUID_REGEX_USER.test(userId)) {
        return userBadRequest(reply, request, 'VALIDATION_ERROR', 'Invalid user id');
      }

      const bodySchema = z
        .object({
          scope_type: scopeTypeEnum,
          scope_id: z.string().uuid().nullable().optional(),
          granted: z.boolean(),
          notes: z.string().max(1000).nullable().optional(),
        })
        .refine(
          (v) =>
            v.scope_type === 'global'
              ? v.scope_id == null
              : typeof v.scope_id === 'string',
          {
            message: 'scope_id is required unless scope_type=global',
            path: ['scope_id'],
          },
        );

      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) return userValidationError(reply, request, parsed.error);
      const { scope_type, granted, notes } = parsed.data;
      const scope_id = parsed.data.scope_id ?? null;

      const [userRow] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!userRow) {
        return userNotFound(reply, request, 'NOT_FOUND', 'User not found');
      }

      // Hit the catalog table directly so freshly-seeded permissions
      // added by a delta migration since the codegen array shipped
      // are honored without a rebuild.
      const [permRow] = await db
        .select({ id: permissions.id })
        .from(permissions)
        .where(eq(permissions.id, permissionId))
        .limit(1);
      if (!permRow) {
        return reply.status(404).send({
          error: {
            code: 'PERMISSION_NOT_IN_CATALOG',
            message: `Permission ${permissionId} not in catalog`,
            details: [],
            request_id: request.id,
          },
        });
      }

      const actor = request.user!;
      let row;
      try {
        row = await db.transaction(async (tx) => {
          // UPSERT on composite PK. is_snapshot is false here (or
          // promoted from true when an auto-snapshot becomes an
          // explicit operator-set override).
          const [existing] = await tx
            .select()
            .from(accountPermissions)
            .where(
              and(
                eq(accountPermissions.user_id, userId),
                eq(accountPermissions.scope_type, scope_type),
                scope_id == null
                  ? isNull(accountPermissions.scope_id)
                  : eq(accountPermissions.scope_id, scope_id),
                eq(accountPermissions.permission_id, permissionId),
              ),
            )
            .limit(1);

          if (existing) {
            await tx
              .update(accountPermissions)
              .set({
                granted,
                is_snapshot: false,
                set_by: actor.id,
                set_at: new Date(),
                notes: notes ?? null,
              })
              .where(
                and(
                  eq(accountPermissions.user_id, userId),
                  eq(accountPermissions.scope_type, scope_type),
                  scope_id == null
                    ? isNull(accountPermissions.scope_id)
                    : eq(accountPermissions.scope_id, scope_id),
                  eq(accountPermissions.permission_id, permissionId),
                ),
              );
          } else {
            await tx.insert(accountPermissions).values({
              user_id: userId,
              scope_type,
              scope_id,
              permission_id: permissionId,
              granted,
              is_snapshot: false,
              set_by: actor.id,
              notes: notes ?? null,
            });
          }

          const [reread] = await tx
            .select({
              user_id: accountPermissions.user_id,
              scope_type: accountPermissions.scope_type,
              scope_id: accountPermissions.scope_id,
              permission_id: accountPermissions.permission_id,
              granted: accountPermissions.granted,
              is_snapshot: accountPermissions.is_snapshot,
              set_by: accountPermissions.set_by,
              set_at: accountPermissions.set_at,
              notes: accountPermissions.notes,
            })
            .from(accountPermissions)
            .where(
              and(
                eq(accountPermissions.user_id, userId),
                eq(accountPermissions.scope_type, scope_type),
                scope_id == null
                  ? isNull(accountPermissions.scope_id)
                  : eq(accountPermissions.scope_id, scope_id),
                eq(accountPermissions.permission_id, permissionId),
              ),
            )
            .limit(1);
          return reread;
        });
      } catch (err) {
        request.log.error({ err }, 'permissions-admin: set_override failed');
        return reply.status(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to set override',
            details: [],
            request_id: request.id,
          },
        });
      }

      await invalidateUser(fastify, userId);
      await logSuperuserAction({
        superuserId: actor.id,
        action: 'permissions.user.set_override',
        targetType: 'user',
        targetId: userId,
        details: {
          scope_type,
          scope_id,
          permission_id: permissionId,
          granted,
        },
        ipAddress: request.ip,
      });

      return reply.send({
        data: {
          override: {
            user_id: row!.user_id,
            scope_type: row!.scope_type,
            scope_id: row!.scope_id,
            permission_id: row!.permission_id,
            granted: row!.granted,
            is_snapshot: row!.is_snapshot,
            set_by: row!.set_by ?? null,
            set_at: row!.set_at?.toISOString() ?? null,
            notes: row!.notes ?? null,
          },
        },
      });
    },
  );

  // ─────────────────────────────────────────────────────────────────
  // DELETE /superuser/permissions/users/:id/overrides/:permission_id
  //
  // Remove a single explicit override at a scope. The user is NOT
  // re-attached — detached_at and the other auto-snapshot rows stay
  // put. Use the reattach endpoint for that.
  // ─────────────────────────────────────────────────────────────────
  fastify.delete<{
    Params: { id: string; permission_id: string };
    Body: {
      scope_type: 'global' | 'org' | 'project';
      scope_id?: string | null;
    };
  }>(
    '/superuser/permissions/users/:id/overrides/:permission_id',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.superuser_permission_user.clear_override'),
      ],
    },
    async (request, reply) => {
      const userId = request.params.id;
      const permissionId = request.params.permission_id;
      if (!UUID_REGEX_USER.test(userId)) {
        return userBadRequest(reply, request, 'VALIDATION_ERROR', 'Invalid user id');
      }

      const bodySchema = z
        .object({
          scope_type: scopeTypeEnum,
          scope_id: z.string().uuid().nullable().optional(),
        })
        .refine(
          (v) =>
            v.scope_type === 'global'
              ? v.scope_id == null
              : typeof v.scope_id === 'string',
          {
            message: 'scope_id is required unless scope_type=global',
            path: ['scope_id'],
          },
        );

      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) return userValidationError(reply, request, parsed.error);
      const { scope_type } = parsed.data;
      const scope_id = parsed.data.scope_id ?? null;

      const actor = request.user!;
      let deletedCount: number;
      try {
        deletedCount = await db.transaction(async (tx) => {
          const deleted = await tx
            .delete(accountPermissions)
            .where(
              and(
                eq(accountPermissions.user_id, userId),
                eq(accountPermissions.scope_type, scope_type),
                scope_id == null
                  ? isNull(accountPermissions.scope_id)
                  : eq(accountPermissions.scope_id, scope_id),
                eq(accountPermissions.permission_id, permissionId),
              ),
            )
            .returning({ permission_id: accountPermissions.permission_id });
          return deleted.length;
        });
      } catch (err) {
        request.log.error({ err }, 'permissions-admin: clear_override failed');
        return reply.status(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to clear override',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (deletedCount === 0) {
        return userNotFound(reply, request, 'NOT_FOUND', 'Override not found');
      }

      await invalidateUser(fastify, userId);
      await logSuperuserAction({
        superuserId: actor.id,
        action: 'permissions.user.clear_override',
        targetType: 'user',
        targetId: userId,
        details: { scope_type, scope_id, permission_id: permissionId },
        ipAddress: request.ip,
      });

      return reply.send({ data: { dropped: deletedCount } });
    },
  );

  // ─────────────────────────────────────────────────────────────────
  // POST /superuser/permissions/users/:id/reattach
  //
  // Drop ALL account_permissions rows at the given scope (explicit
  // operator overrides AND auto-snapshots) and clear detached_at on
  // the matching membership. The user is now live-attached again and
  // group-default edits will propagate. This is the explicit "factory
  // reset" for a user at a scope.
  // ─────────────────────────────────────────────────────────────────
  fastify.post<{
    Params: { id: string };
    Body: {
      scope_type: 'global' | 'org' | 'project';
      scope_id?: string | null;
    };
  }>(
    '/superuser/permissions/users/:id/reattach',
    {
      preHandler: [
        requireAuth,
        fastify.requireCan('bam.superuser_permission_user.reattach'),
      ],
    },
    async (request, reply) => {
      const userId = request.params.id;
      if (!UUID_REGEX_USER.test(userId)) {
        return userBadRequest(reply, request, 'VALIDATION_ERROR', 'Invalid user id');
      }

      const bodySchema = z
        .object({
          scope_type: scopeTypeEnum,
          scope_id: z.string().uuid().nullable().optional(),
        })
        .refine(
          (v) =>
            v.scope_type === 'global'
              ? v.scope_id == null
              : typeof v.scope_id === 'string',
          {
            message: 'scope_id is required unless scope_type=global',
            path: ['scope_id'],
          },
        );

      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) return userValidationError(reply, request, parsed.error);
      const { scope_type } = parsed.data;
      const scope_id = parsed.data.scope_id ?? null;

      const [userRow] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1);
      if (!userRow) {
        return userNotFound(reply, request, 'NOT_FOUND', 'User not found');
      }

      const actor = request.user!;
      let result;
      try {
        result = await db.transaction(async (tx) => {
          const deleted = await tx
            .delete(accountPermissions)
            .where(
              and(
                eq(accountPermissions.user_id, userId),
                eq(accountPermissions.scope_type, scope_type),
                scope_id == null
                  ? isNull(accountPermissions.scope_id)
                  : eq(accountPermissions.scope_id, scope_id),
              ),
            )
            .returning({ permission_id: accountPermissions.permission_id });

          // Idempotent: no-op when no membership row exists or
          // detached_at was already NULL.
          await tx
            .update(accountGroupMemberships)
            .set({ detached_at: null, detached_by: null })
            .where(
              and(
                eq(accountGroupMemberships.user_id, userId),
                eq(accountGroupMemberships.scope_type, scope_type),
                scope_id == null
                  ? isNull(accountGroupMemberships.scope_id)
                  : eq(accountGroupMemberships.scope_id, scope_id),
              ),
            );

          return { dropped: deleted.length };
        });
      } catch (err) {
        request.log.error({ err }, 'permissions-admin: reattach failed');
        return reply.status(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to reattach',
            details: [],
            request_id: request.id,
          },
        });
      }

      await invalidateUser(fastify, userId);
      await logSuperuserAction({
        superuserId: actor.id,
        action: 'permissions.user.reattach',
        targetType: 'user',
        targetId: userId,
        details: {
          scope_type,
          scope_id,
          dropped_overrides: result!.dropped,
        },
        ipAddress: request.ip,
      });

      return reply.send({ data: { dropped_overrides: result!.dropped } });
    },
  );
}

// ═════════════════════════════════════════════════════════════════════
// Wave F.1.a helpers
// ═════════════════════════════════════════════════════════════════════

// Member built-in group id, seeded by 0146. Default clone source for new
// custom groups and the fallback baseline for the reset endpoint when a
// custom group has no explicit clone-source recorded.
const MEMBER_GROUP_ID = '33333333-3333-4333-8333-333333333333';

// Translates `bam.task.*` / `bam.*` / explicit IDs into the set of catalog
// permission_ids they match. Returns:
//   { ids: Set<string>, unknown: string[] }
// where `unknown` is any explicit (non-glob) entry not in the catalog —
// surfaced as 422 by the caller. Resolves against the in-process
// PERMISSIONS_BY_ID map rather than postgres so a 1000+ catalog edit runs
// in O(catalog_size) once instead of O(catalog_size * pattern_count)
// round trips; the catalog drift guard keeps the in-process map in sync
// with the DB.
function expandGlobs(patterns: readonly string[]): { ids: Set<string>; unknown: string[] } {
  const ids = new Set<string>();
  const unknown: string[] = [];
  for (const raw of patterns) {
    const pattern = String(raw).trim();
    if (!pattern) continue;
    if (pattern.endsWith('.*')) {
      // <prefix>.*: every id starting with `${prefix}.`. Both `bam.task.*`
      // and `bam.*` reduce to this form.
      const prefix = pattern.slice(0, -2);
      for (const meta of PERMISSIONS) {
        if (meta.id.startsWith(prefix + '.')) ids.add(meta.id);
      }
      continue;
    }
    if (PERMISSIONS_BY_ID.has(pattern)) {
      ids.add(pattern);
    } else {
      unknown.push(pattern);
    }
  }
  return { ids, unknown };
}

// Publish to Redis + per-user fan-out so every replica drops cached
// PermissionContexts that join through this group.
async function invalidateGroup(
  fastify: FastifyInstance,
  groupId: string,
  affectedUsers: readonly { user_id: string; scope_id: string | null }[],
): Promise<void> {
  const redis = (fastify as unknown as {
    redis?: { publish?: (ch: string, msg: string) => Promise<number> };
  }).redis;
  if (redis?.publish) {
    try {
      await redis.publish(INVALIDATION_CHANNELS.group(groupId), '');
    } catch {
      // Best-effort; TTL cleanup is the fallback.
    }
  }
  for (const m of affectedUsers) {
    try {
      await invalidatePermissionsForUser(m.user_id, m.scope_id ?? undefined);
    } catch {
      // Cache misses heal in <5 min via TTL.
    }
    if (redis?.publish) {
      try {
        await redis.publish(INVALIDATION_CHANNELS.user(m.user_id), m.scope_id ?? '');
      } catch {
        // Best-effort.
      }
    }
  }
}

// Zod schemas (F.1.a-scoped).
const scopeTypeGroupSchema = z.enum(['global', 'org', 'project']);

const createGroupBody = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  scope_type: scopeTypeGroupSchema,
  scope_id: z.string().uuid().nullable().optional(),
  clone_from_group_id: z.string().uuid().optional(),
});

const updateGroupBody = z
  .object({
    name: z.string().min(1).max(100).optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: 'At least one of name/description must be set',
  });

const setDefaultsBody = z
  .object({
    set_true: z.array(z.string()).max(5000).optional(),
    set_false: z.array(z.string()).max(5000).optional(),
    reset_to_builtin: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.reset_to_builtin === true ||
      (v.set_true && v.set_true.length > 0) ||
      (v.set_false && v.set_false.length > 0),
    {
      message:
        'At least one of set_true/set_false must be non-empty, or reset_to_builtin=true',
    },
  );

// Shared reset implementation. Used by both POST /reset and PUT /defaults
// when reset_to_builtin=true. The baseline snapshot is the post-Wave-A
// state of permission_group_defaults captured by migration 0161; for
// custom groups (no baseline of their own), we fall back to Member's.
async function resetGroupDefaults(
  fastify: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  groupId: string,
): Promise<FastifyReply> {
  const [group] = await db
    .select()
    .from(permissionGroups)
    .where(eq(permissionGroups.id, groupId))
    .limit(1);
  if (!group) {
    return reply.status(404).send({
      error: { code: 'NOT_FOUND', message: 'Group not found', request_id: request.id },
    });
  }

  const summary = await db.transaction(async (tx) => {
    // For built-in groups the baseline source is the group itself. For
    // custom groups the contract says "resets to the group's clone-
    // source's current defaults (or Member's defaults if no clone source)"
    // — we don't track clone source explicitly yet, so always fall back
    // to Member's baseline.
    const baselineSourceId = group.is_builtin ? groupId : MEMBER_GROUP_ID;

    const baselineCountRows = (await tx.execute(sql`
      SELECT count(*)::int AS baseline_count
      FROM permission_group_defaults_baseline
      WHERE group_id = ${baselineSourceId}
    `)) as unknown as { baseline_count: number }[];
    const baselineCount = baselineCountRows[0]?.baseline_count ?? 0;

    if (baselineCount === 0) {
      // Shouldn't happen post-0161; bail loudly rather than wipe defaults.
      throw new Error(
        `No baseline snapshot rows for group_id=${baselineSourceId}; was migration 0161 applied?`,
      );
    }

    const before = await tx
      .select({
        permission_id: permissionGroupDefaults.permission_id,
        granted: permissionGroupDefaults.granted,
      })
      .from(permissionGroupDefaults)
      .where(eq(permissionGroupDefaults.group_id, groupId));
    const beforeMap = new Map(before.map((r) => [r.permission_id, r.granted]));

    await tx.execute(sql`DELETE FROM permission_group_defaults WHERE group_id = ${groupId}`);
    await tx.execute(sql`
      INSERT INTO permission_group_defaults (group_id, permission_id, granted)
      SELECT ${groupId}::uuid, permission_id, granted
      FROM permission_group_defaults_baseline
      WHERE group_id = ${baselineSourceId}
      ON CONFLICT (group_id, permission_id) DO UPDATE SET granted = EXCLUDED.granted
    `);

    const after = await tx
      .select({
        permission_id: permissionGroupDefaults.permission_id,
        granted: permissionGroupDefaults.granted,
      })
      .from(permissionGroupDefaults)
      .where(eq(permissionGroupDefaults.group_id, groupId));
    const afterMap = new Map(after.map((r) => [r.permission_id, r.granted]));

    let changed = 0;
    for (const [pid, granted] of afterMap.entries()) {
      if (beforeMap.get(pid) !== granted) changed++;
    }
    for (const [pid] of beforeMap.entries()) {
      if (!afterMap.has(pid)) changed++;
    }

    await tx
      .update(permissionGroups)
      .set({ updated_at: new Date() })
      .where(eq(permissionGroups.id, groupId));

    const now_granted = [...afterMap.values()].filter((g) => g).length;
    const now_denied = afterMap.size - now_granted;
    return { changed, now_granted, now_denied };
  });

  const members = await db
    .select({
      user_id: accountGroupMemberships.user_id,
      scope_id: accountGroupMemberships.scope_id,
    })
    .from(accountGroupMemberships)
    .where(
      and(
        eq(accountGroupMemberships.group_id, groupId),
        isNull(accountGroupMemberships.detached_at),
      ),
    );
  await invalidateGroup(fastify, groupId, members);

  return reply.send({ data: { group_id: groupId, ...summary } });
}
