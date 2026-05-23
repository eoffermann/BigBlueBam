import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { beaconEntries, projectMemberships, users, projects } from '../db/schema/index.js';

const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;
function roleLevel(role: string): number {
  const idx = ROLE_HIERARCHY.indexOf(role as (typeof ROLE_HIERARCHY)[number]);
  return idx >= 0 ? idx : -1;
}

/**
 * Beacon-specific ownership / edit guard.
 *
 * For routes that accept :id param, loads the beacon and checks:
 *   - SuperUser: always allowed
 *   - Admin / Owner (org role): allowed on any beacon in their org
 *   - Member: allowed only if they own the beacon (owned_by or created_by)
 *
 * Attaches `request.beacon` for downstream handlers so the route doesn't
 * need to re-query.
 */

declare module 'fastify' {
  interface FastifyRequest {
    beacon?: {
      id: string;
      organization_id: string;
      project_id: string | null;
      owned_by: string;
      created_by: string;
      status: string;
      [key: string]: unknown;
    };
  }
}

export function requireBeaconEditAccess() {
  return async function checkBeaconEditAccess(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          details: [],
          request_id: request.id,
        },
      });
    }

    const { id } = request.params as { id: string };
    if (!id) {
      return reply.status(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'Beacon id is required',
          details: [],
          request_id: request.id,
        },
      });
    }

    const [beacon] = await db
      .select()
      .from(beaconEntries)
      .where(eq(beaconEntries.id, id))
      .limit(1);

    if (!beacon) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Beacon not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Ensure beacon belongs to user's org
    if (beacon.organization_id !== request.user.org_id && !request.user.is_superuser) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Beacon not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Attach to request for downstream
    (request as any).beacon = beacon;

    if (request.user.is_superuser) return;

    // Project-scoped beacons require project membership
    if (beacon.project_id) {
      const isOwnerOrCreator = beacon.owned_by === request.user.id || beacon.created_by === request.user.id;
      if (!isOwnerOrCreator) {
        const [membership] = await db
          .select({ id: projectMemberships.id })
          .from(projectMemberships)
          .where(
            and(
              eq(projectMemberships.project_id, beacon.project_id),
              eq(projectMemberships.user_id, request.user.id),
            ),
          )
          .limit(1);

        if (!membership) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Beacon not found',
              details: [],
              request_id: request.id,
            },
          });
        }
      }
    }

    // Admin / Owner can edit any beacon in org
    if (roleLevel(request.user.role) >= roleLevel('admin')) return;

    // Member can only edit own beacons
    if (beacon.owned_by === request.user.id || beacon.created_by === request.user.id) {
      return;
    }

    return reply.status(403).send({
      error: {
        code: 'FORBIDDEN',
        message: 'You do not have permission to modify this beacon',
        details: [],
        request_id: request.id,
      },
    });
  };
}

/**
 * Read-access guard: loads beacon and ensures user can see it.
 * Members can read anything in their org (respecting visibility).
 * Attaches beacon to request.
 */
export function requireBeaconReadAccess() {
  return async function checkBeaconReadAccess(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) {
      return reply.status(401).send({
        error: {
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
          details: [],
          request_id: request.id,
        },
      });
    }

    const { id } = request.params as { id: string };
    if (!id) {
      return reply.status(400).send({
        error: {
          code: 'BAD_REQUEST',
          message: 'Beacon id is required',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Accept UUID or slug
    const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const isUuid = UUID_REGEX.test(id);
    const condition = isUuid
      ? eq(beaconEntries.id, id)
      : eq(beaconEntries.slug, id);

    const rows = await db
      .select({
        beacon: beaconEntries,
        owner_name: users.display_name,
        project_name: projects.name,
      })
      .from(beaconEntries)
      .leftJoin(users, eq(users.id, beaconEntries.owned_by))
      .leftJoin(projects, eq(projects.id, beaconEntries.project_id))
      .where(condition)
      .limit(1);
    const row = rows[0];
    const beacon = row ? { ...row.beacon, owner_name: row.owner_name, project_name: row.project_name } : undefined;

    if (!beacon) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Beacon not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Org check
    if (beacon.organization_id !== request.user.org_id && !request.user.is_superuser) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Beacon not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Private visibility check
    if (
      beacon.visibility === 'Private' &&
      beacon.owned_by !== request.user.id &&
      beacon.created_by !== request.user.id &&
      !request.user.is_superuser
    ) {
      return reply.status(404).send({
        error: {
          code: 'NOT_FOUND',
          message: 'Beacon not found',
          details: [],
          request_id: request.id,
        },
      });
    }

    // Project visibility check: require project membership
    if (
      beacon.visibility === 'Project' &&
      beacon.project_id &&
      beacon.owned_by !== request.user.id &&
      beacon.created_by !== request.user.id &&
      !request.user.is_superuser
    ) {
      const [membership] = await db
        .select({ id: projectMemberships.id })
        .from(projectMemberships)
        .where(
          and(
            eq(projectMemberships.project_id, beacon.project_id),
            eq(projectMemberships.user_id, request.user.id),
          ),
        )
        .limit(1);

      if (!membership) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Beacon not found',
            details: [],
            request_id: request.id,
          },
        });
      }
    }

    (request as any).beacon = beacon;
  };
}
