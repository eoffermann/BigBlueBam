import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { beaconEntries, users, projects } from '../db/schema/index.js';
import { beaconRefLookup } from '../lib/beacon-ref.js';
import { resolveBeaconAccess } from '../lib/beacon-access.js';

/**
 * Beacon read / edit guards for routes that take an `:id` param.
 *
 * The rule itself lives in lib/beacon-access.ts (#299) and is shared with the
 * Yjs socket and the slug upsert, so every write path applies the same one:
 *   - cannot read the row (another org, Private and not yours, Project and not
 *     a member): 404, so the row's existence never leaks;
 *   - can read but not edit: 403;
 *   - can edit: continue, with the row attached as `request.beacon`.
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

function notFound(request: FastifyRequest, reply: FastifyReply) {
  return reply.status(404).send({
    error: {
      code: 'NOT_FOUND',
      message: 'Beacon not found',
      details: [],
      request_id: request.id,
    },
  });
}

function unauthenticated(request: FastifyRequest, reply: FastifyReply) {
  return reply.status(401).send({
    error: {
      code: 'UNAUTHORIZED',
      message: 'Authentication required',
      details: [],
      request_id: request.id,
    },
  });
}

function missingId(request: FastifyRequest, reply: FastifyReply) {
  return reply.status(400).send({
    error: {
      code: 'BAD_REQUEST',
      message: 'Beacon id is required',
      details: [],
      request_id: request.id,
    },
  });
}

export function requireBeaconEditAccess() {
  return async function checkBeaconEditAccess(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) return unauthenticated(request, reply);

    const { id } = request.params as { id: string };
    if (!id) return missingId(request, reply);

    const [beacon] = await db
      .select()
      .from(beaconEntries)
      .where(eq(beaconEntries.id, id))
      .limit(1);
    if (!beacon) return notFound(request, reply);

    const level = await resolveBeaconAccess(request.user, beacon);
    if (level === 'none') return notFound(request, reply);
    if (level === 'read') {
      return reply.status(403).send({
        error: {
          code: 'FORBIDDEN',
          message: 'You do not have permission to modify this beacon',
          details: [],
          request_id: request.id,
        },
      });
    }

    (request as any).beacon = beacon;
  };
}

/**
 * Read-access guard: loads the beacon by UUID or slug and ensures the caller
 * can see it. Attaches the row (plus owner and project names) to the request.
 */
export function requireBeaconReadAccess() {
  return async function checkBeaconReadAccess(request: FastifyRequest, reply: FastifyReply) {
    if (!request.user) return unauthenticated(request, reply);

    const { id } = request.params as { id: string };
    if (!id) return missingId(request, reply);

    // Accept UUID or slug. Slugs are unique per org (#246), so a slug resolves
    // within the caller's org; see lib/beacon-ref.ts.
    const lookup = beaconRefLookup(id, request.user.org_id, request.user.is_superuser);

    const rows = await db
      .select({
        beacon: beaconEntries,
        owner_name: users.display_name,
        project_name: projects.name,
      })
      .from(beaconEntries)
      .leftJoin(users, eq(users.id, beaconEntries.owned_by))
      .leftJoin(projects, eq(projects.id, beaconEntries.project_id))
      .where(lookup.where)
      .orderBy(lookup.orderBy)
      .limit(1);
    const row = rows[0];
    const beacon = row ? { ...row.beacon, owner_name: row.owner_name, project_name: row.project_name } : undefined;
    if (!beacon) return notFound(request, reply);

    const level = await resolveBeaconAccess(request.user, beacon);
    if (level === 'none') return notFound(request, reply);

    (request as any).beacon = beacon;
  };
}
