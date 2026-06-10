import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { bureauSettings } from '../db/schema/bureau.js';
import { requireAuth } from '../plugins/auth.js';

const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;

function roleLevel(role: string): number {
  const idx = ROLE_HIERARCHY.indexOf(role as (typeof ROLE_HIERARCHY)[number]);
  return idx >= 0 ? idx : -1;
}

function isOrgAdminOrOwner(role: string): boolean {
  return roleLevel(role) >= roleLevel('admin');
}

const updateSettingsBody = z.object({
  continuous_audio: z.boolean().optional(),
  allow_auto_follow: z.boolean().optional(),
  default_office_privacy: z.enum(['open', 'knock', 'private']).optional(),
  members_can_book: z.boolean().optional(),
  members_can_create_rooms: z.boolean().optional(),
});

/**
 * Ensure a bureau_settings row exists for this org. Returns the row.
 * Uses an idempotent insert; ignores conflict on the org_id PK.
 */
async function ensureSettings(orgId: string) {
  const [existing] = await db
    .select()
    .from(bureauSettings)
    .where(eq(bureauSettings.org_id, orgId))
    .limit(1);
  if (existing) return existing;

  // Insert defaults (all defaults are encoded in the column definitions).
  const [created] = await db
    .insert(bureauSettings)
    .values({ org_id: orgId })
    .onConflictDoNothing({ target: bureauSettings.org_id })
    .returning();

  if (created) return created;

  // Race: someone else inserted between our select and insert. Re-read.
  const [row] = await db
    .select()
    .from(bureauSettings)
    .where(eq(bureauSettings.org_id, orgId))
    .limit(1);
  return row;
}

export default async function settingsRoutes(fastify: FastifyInstance) {
  // GET /v1/settings — org Bureau settings (creates a default row if none exists).
  fastify.get(
    '/settings',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;
      const settings = await ensureSettings(user.org_id);

      if (!settings) {
        return reply.status(500).send({
          error: {
            code: 'INTERNAL_ERROR',
            message: 'Failed to load or create bureau settings',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: settings });
    },
  );

  // PATCH /v1/settings — update settings fields. Admin/owner only.
  fastify.patch(
    '/settings',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;

      if (!user.is_superuser && !isOrgAdminOrOwner(user.role)) {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Only org admins or owners can update bureau settings',
            details: [],
            request_id: request.id,
          },
        });
      }

      const body = updateSettingsBody.parse(request.body);

      // Make sure a row exists, then update.
      await ensureSettings(user.org_id);

      const updates: Record<string, unknown> = { updated_at: new Date() };
      if (body.continuous_audio !== undefined) updates.continuous_audio = body.continuous_audio;
      if (body.allow_auto_follow !== undefined) updates.allow_auto_follow = body.allow_auto_follow;
      if (body.default_office_privacy !== undefined) {
        updates.default_office_privacy = body.default_office_privacy;
      }
      if (body.members_can_book !== undefined) updates.members_can_book = body.members_can_book;
      if (body.members_can_create_rooms !== undefined) {
        updates.members_can_create_rooms = body.members_can_create_rooms;
      }

      const [updated] = await db
        .update(bureauSettings)
        .set(updates)
        .where(eq(bureauSettings.org_id, user.org_id))
        .returning();

      return reply.send({ data: updated });
    },
  );
}
