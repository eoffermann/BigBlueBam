/**
 * Bureau "Hunt" — where is a specific user right now?
 *
 *   GET /v1/presence/where/:userId
 *
 * Returns the target user's current location (url/app/label/status)
 * from their live Bureau presence sessions, so the caller can jump to
 * them ("Hunt" in the docked box). Counterpart of presence-here
 * (who-is-on-this-URL); this is which-URL-is-this-user-on.
 *
 * Privacy model:
 *   - Org-scoped: the target must share the caller's active org, and
 *     only sessions belonging to that org are considered (a user
 *     working in a different org right now reads as "not located").
 *     404 (not 403) on non-members so user-id probing can't confirm
 *     existence — same convention as ring.routes.ts.
 *   - DND: a target with any live DND session is not locatable. Hunt
 *     is strictly more invasive than ring, so it respects at least the
 *     same boundary.
 *   - Destination access: before revealing the location we run the
 *     caller through the same cross-app access preflight presence-here
 *     uses — if the caller can't see that URL, the answer is the same
 *     as "not located" (denial is indistinguishable from absence, per
 *     §10 "denial is private to the denied").
 *
 * Access to the destination is ultimately enforced on arrival anyway
 * (the target app's own auth + the symmetric-auth room mint); the
 * preflight just avoids leaking WHERE someone is through a URL the
 * caller couldn't open.
 *
 * Response: { data: { located: true, url, app, label, status } }
 *        or { data: { located: false } }   (offline / hidden / DND)
 */

import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { launchpadAppFromUrl } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { organizationMemberships, users } from '../db/schema/index.js';
import { requireAuth } from '../plugins/auth.js';
import { badRequest, notFound } from '../middleware/room-access.js';
import { keys as presenceKeys } from '../services/presence.service.js';
import { isUserInDnd } from '../services/dnd-check.service.js';
import { resolveAccess, type CrossAppName } from '../services/cross-app-access.service.js';

const paramsSchema = z.object({
  userId: z.string().uuid(),
});

/** Mirrors presence-here.routes.ts::classifyUrlApp — first path segment
 *  → cross-app-access app name. Informational: the shared resolver denies
 *  a URL it cannot classify (#300). */
function classifyUrlApp(rawUrl: string): string | null {
  // Issue #158: the shared Launchpad app list, same as presence-here.
  return launchpadAppFromUrl(rawUrl);
}

export default async function presenceWhereRoutes(fastify: FastifyInstance) {
  fastify.get(
    '/presence/where/:userId',
    { preHandler: [requireAuth, fastify.requireCan('bureau.presence.read')] },
    async (request, reply) => {
      const user = request.user!;

      const parsed = paramsSchema.safeParse(request.params);
      if (!parsed.success) {
        return badRequest(request, reply, 'Invalid user id');
      }
      const targetUserId = parsed.data.userId;

      if (targetUserId === user.id) {
        return badRequest(request, reply, 'You are already where you are');
      }

      // Org membership gate — identical shape to ring.routes.ts.
      const [target] = await db
        .select({ id: users.id, org_id: users.org_id, is_active: users.is_active })
        .from(users)
        .where(eq(users.id, targetUserId))
        .limit(1);
      let targetInOrg = !!target && target.org_id === user.org_id;
      if (target && !targetInOrg) {
        const [membership] = await db
          .select({ id: organizationMemberships.id })
          .from(organizationMemberships)
          .where(
            and(
              eq(organizationMemberships.user_id, targetUserId),
              eq(organizationMemberships.org_id, user.org_id),
            ),
          )
          .limit(1);
        targetInOrg = !!membership;
      }
      if (!target || !target.is_active || !targetInOrg) {
        return notFound(request, reply, 'User not found in your organization');
      }

      // DND: not locatable while in Do Not Disturb.
      if (await isUserInDnd(fastify.redis, targetUserId)) {
        return reply.status(200).send({ data: { located: false } });
      }

      // Read the target's live sessions (TTL'd at 35s — anything present
      // is fresh). Pick the first org-matching session reporting a URL.
      const sessionIds = await fastify.redis.smembers(
        presenceKeys.userSessions(targetUserId),
      );
      let found: { url: string; app: string | null; label: string | null; status: string } | null =
        null;
      if (sessionIds.length > 0) {
        const pipeline = fastify.redis.pipeline();
        for (const sessionId of sessionIds) {
          pipeline.hmget(
            presenceKeys.session(sessionId),
            'orgId',
            'locationUrl',
            'locationApp',
            'locationLabel',
            'status',
          );
        }
        const results = await pipeline.exec();
        for (const entry of results ?? []) {
          if (!entry) continue;
          const [err, value] = entry;
          if (err || !Array.isArray(value)) continue;
          const [orgId, locationUrl, locationApp, locationLabel, status] =
            value as Array<string | null>;
          if (!orgId || orgId !== user.org_id) continue;
          if (!locationUrl) continue;
          found = {
            url: locationUrl,
            app: locationApp ?? null,
            label: locationLabel ?? null,
            status: status && status.length > 0 ? status : 'available',
          };
          break;
        }
      }

      if (!found) {
        return reply.status(200).send({ data: { located: false } });
      }

      // Destination-access preflight: if the CALLER can't see the URL the
      // target is on, answer exactly as if the target weren't located. Fail
      // CLOSED (#300): an unclassifiable URL, an app the api cannot map, a
      // peer error and a thrown error all mean "not located".
      const allowed = await resolveAccess(
        {
          orgId: user.org_id,
          userId: user.id,
          app: (classifyUrlApp(found.url) ?? undefined) as CrossAppName | undefined,
          targetUrl: found.url,
        },
        { log: request.log },
      )
        .then((d) => d.allowed)
        .catch(() => false);
      if (!allowed) {
        return reply.status(200).send({ data: { located: false } });
      }

      return reply.status(200).send({
        data: {
          located: true,
          url: found.url,
          app: found.app,
          label: found.label,
          status: found.status,
        },
      });
    },
  );
}
