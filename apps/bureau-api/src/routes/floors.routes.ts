import type { FastifyInstance } from 'fastify';
import { and, eq, isNull, asc } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { bureauBuildings, bureauFloors, bureauRooms } from '../db/schema/bureau.js';
import { requireAuth } from '../plugins/auth.js';

const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;

function roleLevel(role: string): number {
  const idx = ROLE_HIERARCHY.indexOf(role as (typeof ROLE_HIERARCHY)[number]);
  return idx >= 0 ? idx : -1;
}

function isOrgAdminOrOwner(role: string): boolean {
  return roleLevel(role) >= roleLevel('admin');
}

const createFloorBody = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(140).regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with dashes'),
  layout: z.record(z.unknown()).optional(),
  background_url: z.string().max(2048).nullable().optional(),
  building_id: z.string().uuid().nullable().optional(),
  position: z.number().int().min(0).optional(),
  is_default: z.boolean().optional(),
});

const updateFloorBody = z.object({
  name: z.string().min(1).max(120).optional(),
  layout: z.record(z.unknown()).optional(),
  background_url: z.string().max(2048).nullable().optional(),
  position: z.number().int().min(0).optional(),
  is_default: z.boolean().optional(),
});

const backgroundBody = z.object({
  background_url: z.string().min(1).max(2048),
});

/**
 * Read live occupancy count for a floor from Redis.
 * Reads bureau:floor:{id}:index HASH size. Falls back to 0 if Redis
 * is not yet populated (workstream 3 owns the presence model).
 */
async function readFloorOccupancy(
  fastify: FastifyInstance,
  floorId: string,
): Promise<number> {
  try {
    return await fastify.redis.hlen(`bureau:floor:${floorId}:index`);
  } catch (err) {
    fastify.log.warn({ err, floor_id: floorId }, 'Failed to read floor occupancy from Redis');
    return 0;
  }
}

/**
 * Read live occupancy per room for a floor from Redis.
 * Reads bureau:room:{id}:occupants SET size for each room on the floor.
 * Falls back to 0 if Redis is not yet populated.
 */
async function readRoomOccupancyMap(
  fastify: FastifyInstance,
  roomIds: string[],
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  if (roomIds.length === 0) return counts;
  try {
    const pipeline = fastify.redis.pipeline();
    for (const id of roomIds) {
      pipeline.scard(`bureau:room:${id}:occupants`);
    }
    const results = await pipeline.exec();
    if (!results) {
      for (const id of roomIds) counts[id] = 0;
      return counts;
    }
    results.forEach((entry, i) => {
      const [err, value] = entry;
      const id = roomIds[i]!;
      counts[id] = err ? 0 : (typeof value === 'number' ? value : 0);
    });
  } catch (err) {
    fastify.log.warn({ err }, 'Failed to read room occupancy map from Redis');
    for (const id of roomIds) counts[id] = 0;
  }
  return counts;
}

export default async function floorsRoutes(fastify: FastifyInstance) {
  // GET /v1/floors — list org's floors with live occupancy count
  fastify.get(
    '/floors',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;

      const floors = await db
        .select()
        .from(bureauFloors)
        .where(and(eq(bureauFloors.org_id, user.org_id), isNull(bureauFloors.archived_at)))
        .orderBy(asc(bureauFloors.position), asc(bureauFloors.name));

      // Read occupancy for each floor in parallel
      const occupancies = await Promise.all(
        floors.map((f) => readFloorOccupancy(fastify, f.id)),
      );

      const data = floors.map((f, i) => ({
        ...f,
        occupancy: occupancies[i] ?? 0,
      }));

      return reply.send({ data });
    },
  );

  // GET /v1/floors/:id — floor metadata + layout + occupancy by room
  fastify.get(
    '/floors/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const [floor] = await db
        .select()
        .from(bureauFloors)
        .where(
          and(
            eq(bureauFloors.id, id),
            eq(bureauFloors.org_id, user.org_id),
            isNull(bureauFloors.archived_at),
          ),
        )
        .limit(1);

      if (!floor) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Floor not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const rooms = await db
        .select({ id: bureauRooms.id, name: bureauRooms.name, zone_id: bureauRooms.zone_id })
        .from(bureauRooms)
        .where(
          and(
            eq(bureauRooms.floor_id, id),
            isNull(bureauRooms.archived_at),
          ),
        );

      const occupancyByRoom = await readRoomOccupancyMap(
        fastify,
        rooms.map((r) => r.id),
      );
      const floorOccupancy = await readFloorOccupancy(fastify, id);

      return reply.send({
        data: {
          ...floor,
          occupancy: floorOccupancy,
          rooms: rooms.map((r) => ({
            id: r.id,
            name: r.name,
            zone_id: r.zone_id,
            occupancy: occupancyByRoom[r.id] ?? 0,
          })),
        },
      });
    },
  );

  // POST /v1/floors — create floor. Admin/owner only.
  fastify.post(
    '/floors',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;

      if (!user.is_superuser && !isOrgAdminOrOwner(user.role)) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Only org admins or owners can create floors',
            details: [],
            request_id: request.id,
          },
        });
      }

      const body = createFloorBody.parse(request.body);

      // If building_id provided, verify it belongs to this org
      if (body.building_id) {
        const [building] = await db
          .select({ id: bureauBuildings.id })
          .from(bureauBuildings)
          .where(
            and(
              eq(bureauBuildings.id, body.building_id),
              eq(bureauBuildings.org_id, user.org_id),
            ),
          )
          .limit(1);
        if (!building) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Building not found',
              details: [{ field: 'building_id', issue: 'not found in this org' }],
              request_id: request.id,
            },
          });
        }
      }

      try {
        const [floor] = await db
          .insert(bureauFloors)
          .values({
            org_id: user.org_id,
            building_id: body.building_id ?? null,
            name: body.name,
            slug: body.slug,
            layout: (body.layout ?? {}) as Record<string, unknown>,
            background_url: body.background_url ?? null,
            position: body.position ?? 0,
            is_default: body.is_default ?? false,
          })
          .returning();

        return reply.status(201).send({ data: { ...floor, occupancy: 0 } });
      } catch (err) {
        // Likely a unique-constraint conflict on (org_id, slug)
        const message = (err as Error).message ?? '';
        if (message.includes('bureau_floors_org_slug_idx') || message.includes('unique')) {
          return reply.status(409).send({
            error: {
              code: 'CONFLICT',
              message: 'A floor with that slug already exists in this organization',
              details: [{ field: 'slug', issue: 'already in use' }],
              request_id: request.id,
            },
          });
        }
        throw err;
      }
    },
  );

  // PATCH /v1/floors/:id — update floor. Admin/owner only.
  fastify.patch(
    '/floors/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      if (!user.is_superuser && !isOrgAdminOrOwner(user.role)) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Only org admins or owners can update floors',
            details: [],
            request_id: request.id,
          },
        });
      }

      const body = updateFloorBody.parse(request.body);

      const [existing] = await db
        .select({ id: bureauFloors.id })
        .from(bureauFloors)
        .where(
          and(
            eq(bureauFloors.id, id),
            eq(bureauFloors.org_id, user.org_id),
            isNull(bureauFloors.archived_at),
          ),
        )
        .limit(1);

      if (!existing) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Floor not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const updates: Record<string, unknown> = { updated_at: new Date() };
      if (body.name !== undefined) updates.name = body.name;
      if (body.layout !== undefined) updates.layout = body.layout;
      if (body.background_url !== undefined) updates.background_url = body.background_url;
      if (body.position !== undefined) updates.position = body.position;
      if (body.is_default !== undefined) updates.is_default = body.is_default;

      const [updated] = await db
        .update(bureauFloors)
        .set(updates)
        .where(eq(bureauFloors.id, id))
        .returning();

      return reply.send({ data: updated });
    },
  );

  // DELETE /v1/floors/:id — soft-delete. Admin/owner only.
  fastify.delete(
    '/floors/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      if (!user.is_superuser && !isOrgAdminOrOwner(user.role)) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Only org admins or owners can delete floors',
            details: [],
            request_id: request.id,
          },
        });
      }

      const [existing] = await db
        .select({ id: bureauFloors.id })
        .from(bureauFloors)
        .where(
          and(
            eq(bureauFloors.id, id),
            eq(bureauFloors.org_id, user.org_id),
            isNull(bureauFloors.archived_at),
          ),
        )
        .limit(1);

      if (!existing) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Floor not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      await db
        .update(bureauFloors)
        .set({ archived_at: new Date(), updated_at: new Date() })
        .where(eq(bureauFloors.id, id));

      return reply.status(204).send();
    },
  );

  // POST /v1/floors/:id/background — set background URL. Admin/owner only.
  // The MinIO upload itself is a separate concern; this just stores the URL.
  fastify.post(
    '/floors/:id/background',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      if (!user.is_superuser && !isOrgAdminOrOwner(user.role)) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Only org admins or owners can update floor backgrounds',
            details: [],
            request_id: request.id,
          },
        });
      }

      const body = backgroundBody.parse(request.body);

      const [existing] = await db
        .select({ id: bureauFloors.id })
        .from(bureauFloors)
        .where(
          and(
            eq(bureauFloors.id, id),
            eq(bureauFloors.org_id, user.org_id),
            isNull(bureauFloors.archived_at),
          ),
        )
        .limit(1);

      if (!existing) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Floor not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const [updated] = await db
        .update(bureauFloors)
        .set({ background_url: body.background_url, updated_at: new Date() })
        .where(eq(bureauFloors.id, id))
        .returning();

      return reply.send({ data: updated });
    },
  );
}
