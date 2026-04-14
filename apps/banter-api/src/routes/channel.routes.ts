import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql, desc, ne, isNull, inArray, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  banterChannels,
  banterChannelMemberships,
  banterMessages,
  banterSettings,
  users,
} from '../db/schema/index.js';
import { requireAuth, requireMinRole, requireScope } from '../plugins/auth.js';
import { requireChannelMember, requireChannelAdmin, requireChannelOwner } from '../middleware/channel-auth.js';
import { broadcastToOrg, broadcastToChannel } from '../services/realtime.js';
import { getEffectiveBanterPermissions } from '../services/org-permissions-bridge.js';
import { publishBoltEvent } from '@bigbluebam/shared';
import { loadEnrichedActor, loadEnrichedOrg } from '../lib/bolt-enrich.js';
import { channelDeepLink, dmDeepLink } from '../lib/notify.js';

/**
 * Derive a coarse presence label from the user's last_seen_at timestamp.
 * This is a LIGHTWEIGHT approximation — real presence (typing indicators,
 * active-tab detection, etc.) would need a per-connection tracker. For
 * sidebar dots, the heuristic is:
 *   - seen within 5 min  → 'online'
 *   - seen within 30 min → 'idle'
 *   - older / never seen → 'offline'
 * Frontend passes this through presenceColor() which maps to Tailwind
 * bg-presence-{online,idle,dnd,offline} classes.
 */
function derivePresence(lastSeenAt: Date | string | null): 'online' | 'idle' | 'offline' {
  if (!lastSeenAt) return 'offline';
  const t = typeof lastSeenAt === 'string' ? new Date(lastSeenAt).getTime() : lastSeenAt.getTime();
  const ageMs = Date.now() - t;
  if (ageMs < 5 * 60 * 1000) return 'online';
  if (ageMs < 30 * 60 * 1000) return 'idle';
  return 'offline';
}

const createChannelSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Must be lowercase alphanumeric with hyphens'),
  type: z.enum(['public', 'private']).default('public'),
  topic: z.string().max(500).optional(),
  description: z.string().optional(),
  channel_group_id: z.string().uuid().optional(),
});

const updateChannelSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  display_name: z.string().max(100).nullable().optional(),
  topic: z.string().max(500).nullable().optional(),
  description: z.string().nullable().optional(),
  icon: z.string().max(10).nullable().optional(),
  channel_group_id: z.string().uuid().nullable().optional(),
  allow_bots: z.boolean().optional(),
  allow_huddles: z.boolean().optional(),
  message_retention_days: z.number().int().min(0).nullable().optional(),
});

const addMembersSchema = z.object({
  user_ids: z.array(z.string().uuid()).min(1).max(100),
});

const markReadSchema = z.object({
  message_id: z.string().uuid(),
});

export default async function channelRoutes(fastify: FastifyInstance) {
  // GET /v1/channels — list user's channels with unread counts
  fastify.get(
    '/v1/channels',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;

      // Auto-create #general if no channels exist for this org.
      // Uses INSERT ... ON CONFLICT DO NOTHING on the unique (org_id, slug) index
      // to avoid a race where two concurrent requests both try to create #general.
      try {
        const [existing] = await db
          .select({ id: banterChannels.id })
          .from(banterChannels)
          .where(and(eq(banterChannels.org_id, user.org_id), eq(banterChannels.type, 'public')))
          .limit(1);

        if (!existing) {
          await db.transaction(async (tx) => {
            // Atomic insert: if another request already created #general, this is a no-op.
            const inserted = await tx
              .insert(banterChannels)
              .values({
                org_id: user.org_id,
                name: 'general',
                slug: 'general',
                type: 'public',
                topic: 'General discussion',
                description: 'The default channel for team communication',
                is_default: true,
                created_by: user.id,
              })
              .onConflictDoNothing({
                target: [banterChannels.org_id, banterChannels.slug],
              })
              .returning();

            const general = inserted[0];
            if (!general) {
              // Another concurrent request won the race; nothing to do.
              return;
            }

            // Add current user as owner
            await tx.insert(banterChannelMemberships).values({
              channel_id: general.id,
              user_id: user.id,
              role: 'owner',
            }).onConflictDoNothing();

            // Add all other active org members
            const orgMembers = await tx.execute(
              sql`SELECT id FROM users WHERE org_id = ${user.org_id} AND is_active = true AND id != ${user.id}`
            );
            const memberRows = Array.isArray(orgMembers) ? orgMembers : (orgMembers as any).rows ?? [];
            for (const m of memberRows) {
              await tx.insert(banterChannelMemberships).values({
                channel_id: general.id,
                user_id: (m as any).id,
                role: 'member',
              }).onConflictDoNothing();
            }

            // Set authoritative member_count from actual memberships
            await tx
              .update(banterChannels)
              .set({
                member_count: sql`(SELECT COUNT(*)::int FROM banter_channel_memberships WHERE channel_id = ${general.id})`,
              })
              .where(eq(banterChannels.id, general.id));
          });
        }
      } catch {
        // Don't fail the channel list if auto-creation fails
      }

      const rows = await db
        .select({
          channel: banterChannels,
          membership: banterChannelMemberships,
        })
        .from(banterChannelMemberships)
        .innerJoin(
          banterChannels,
          eq(banterChannelMemberships.channel_id, banterChannels.id),
        )
        .where(
          and(
            eq(banterChannelMemberships.user_id, user.id),
            // CRITICAL: scope by the caller's active org. Without this
            // predicate, multi-org users see channels from every org they
            // belong to (tenant-isolation leak + UX bug).
            eq(banterChannels.org_id, user.org_id),
            eq(banterChannels.is_archived, false),
          ),
        )
        .orderBy(desc(banterChannels.last_message_at));

      // Resolve the OTHER participant for every DM channel in one query.
      // For type='dm' we need the display_name + avatar_url of the
      // membership row whose user_id is NOT the caller — that's what
      // the sidebar renders as the DM label. Doing this once upfront
      // avoids N+1 lookups in the per-channel loop below.
      const dmChannelIds = rows
        .filter((r) => r.channel.type === 'dm')
        .map((r) => r.channel.id);
      const dmParticipants = new Map<
        string,
        { id: string; display_name: string; avatar_url: string | null }
      >();
      if (dmChannelIds.length > 0) {
        const participantRows = await db
          .select({
            channel_id: banterChannelMemberships.channel_id,
            user_id: users.id,
            display_name: users.display_name,
            avatar_url: users.avatar_url,
            last_seen_at: users.last_seen_at,
          })
          .from(banterChannelMemberships)
          .innerJoin(users, eq(users.id, banterChannelMemberships.user_id))
          .where(
            and(
              inArray(banterChannelMemberships.channel_id, dmChannelIds),
              ne(banterChannelMemberships.user_id, user.id),
            ),
          );
        for (const p of participantRows) {
          dmParticipants.set(p.channel_id, {
            id: p.user_id,
            display_name: p.display_name,
            avatar_url: p.avatar_url,
            presence: derivePresence(p.last_seen_at),
          });
        }
      }

      // Compute unread counts
      const channels = await Promise.all(
        rows.map(async (row) => {
          let unread_count = 0;
          if (row.membership.last_read_message_id) {
            const unreadResult = await db
              .select({ count: sql<number>`count(*)::int` })
              .from(banterMessages)
              .where(
                and(
                  eq(banterMessages.channel_id, row.channel.id),
                  eq(banterMessages.is_deleted, false),
                  isNull(banterMessages.thread_parent_id),
                  sql`${banterMessages.created_at} > (SELECT created_at FROM banter_messages WHERE id = ${row.membership.last_read_message_id})`,
                ),
              );
            unread_count = unreadResult[0]?.count ?? 0;
          } else {
            // No read cursor — everything is unread
            const countResult = await db
              .select({ count: sql<number>`count(*)::int` })
              .from(banterMessages)
              .where(
                and(
                  eq(banterMessages.channel_id, row.channel.id),
                  eq(banterMessages.is_deleted, false),
                  isNull(banterMessages.thread_parent_id),
                ),
              );
            unread_count = countResult[0]?.count ?? 0;
          }

          return {
            ...row.channel,
            role: row.membership.role,
            is_muted: row.membership.is_muted,
            notifications: row.membership.notifications,
            last_read_message_id: row.membership.last_read_message_id,
            unread_count,
            dm_other_participant: dmParticipants.get(row.channel.id) ?? null,
          };
        }),
      );

      return reply.send({ data: channels });
    },
  );

  // POST /v1/channels — create channel
  fastify.post(
    '/v1/channels',
    { preHandler: [requireAuth, requireMinRole('member'), requireScope('read_write')] },
    async (request, reply) => {
      const user = request.user!;
      const body = createChannelSchema.parse(request.body);

      // Enforce org-level banter permissions for non-admin members.
      //
      // P2-23 (accepted staleness): There is a small TOCTOU window between
      // reading banter_settings.allow_channel_creation here and performing
      // the INSERT below. If an org admin flips the setting to 'admins_only'
      // in that window (<10ms for a hot-path Postgres read + insert on the
      // same connection), a member could still create a channel. We accept
      // this — an admin who wants to lock this down can delete the stray
      // channel afterwards, and wrapping check + insert in a serializable
      // transaction would add contention without meaningful safety.
      const isPrivileged = user.is_superuser || user.role === 'admin' || user.role === 'owner';
      if (!isPrivileged) {
        // Single code path for banter permission reads. Cached with 30s TTL
        // and normalized into the OrgPermissions shape used by apps/api.
        const perms = await getEffectiveBanterPermissions(user.org_id);

        if (!perms.members_can_create_channels) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: 'Your organization does not allow members to create channels',
              details: [],
              request_id: request.id,
            },
          });
        }

        // Private channel restriction: piggybacks on allow_channel_creation
        // in the current banter_settings schema. Admins can always create
        // private channels; members obey the mapped flag above.
        if (body.type === 'private' && !perms.members_can_create_private_channels) {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: 'Your organization does not allow members to create private channels',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      // P2-23 (closing the race): Re-read banter_settings directly from the
      // DB (bypassing the 30s cache) right before we INSERT the channel. If
      // an admin flipped `allow_channel_creation` to 'admins' after the
      // initial cached check above, reject with SETTING_CHANGED so the
      // in-flight request doesn't slip through on stale settings.
      if (!isPrivileged) {
        const [freshSettings] = await db
          .select({ allow_channel_creation: banterSettings.allow_channel_creation })
          .from(banterSettings)
          .where(eq(banterSettings.org_id, user.org_id))
          .limit(1);

        const membersCanCreate =
          !freshSettings || (freshSettings.allow_channel_creation ?? 'members') === 'members';

        if (!membersCanCreate) {
          return reply.status(403).send({
            error: {
              code: 'SETTING_CHANGED',
              message:
                'Channel creation permissions changed during this request. Your organization no longer allows members to create channels.',
              details: [],
              request_id: request.id,
            },
          });
        }
        // Private-channel restriction piggybacks on the same flag today
        // (see org-permissions-bridge.ts), so no separate re-check needed.
      }

      // Check if this is the first channel for the org (auto-create #general)
      const existingChannels = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(banterChannels)
        .where(
          and(
            eq(banterChannels.org_id, user.org_id),
            ne(banterChannels.type, 'dm'),
            ne(banterChannels.type, 'group_dm'),
          ),
        );

      const isFirstChannel = (existingChannels[0]?.count ?? 0) === 0;
      const channelName = isFirstChannel ? 'general' : body.name;
      const slug = channelName.toLowerCase().replace(/\s+/g, '-');

      const [channel] = await db
        .insert(banterChannels)
        .values({
          org_id: user.org_id,
          name: channelName,
          slug,
          type: body.type,
          topic: body.topic ?? null,
          description: body.description ?? null,
          channel_group_id: body.channel_group_id ?? null,
          created_by: user.id,
          is_default: isFirstChannel,
          member_count: 1,
        })
        .returning();

      // Auto-add creator as owner
      await db.insert(banterChannelMemberships).values({
        channel_id: channel.id,
        user_id: user.id,
        role: 'owner',
      });

      // If first channel, add all org members
      if (isFirstChannel) {
        const orgUsers = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.org_id, user.org_id), eq(users.is_active, true), ne(users.id, user.id)));

        if (orgUsers.length > 0) {
          await db.insert(banterChannelMemberships).values(
            orgUsers.map((u) => ({
              channel_id: channel.id,
              user_id: u.id,
              role: 'member' as const,
            })),
          );

          // Update member count
          await db
            .update(banterChannels)
            .set({ member_count: orgUsers.length + 1 })
            .where(eq(banterChannels.id, channel.id));
        }
      }

      broadcastToOrg(user.org_id, {
        type: 'channel.created',
        data: { channel },
        timestamp: new Date().toISOString(),
      });

      // Bolt workflow event (fire-and-forget) — payload shape must match
      // the catalog declared in apps/bolt-api/src/services/event-catalog.ts.
      (async () => {
        try {
          if (!channel) return;
          const [enrichedActor, enrichedOrg] = await Promise.all([
            loadEnrichedActor(user.id),
            loadEnrichedOrg(user.org_id),
          ]);
          const isDm = channel.type === 'dm' || channel.type === 'group_dm';
          const channelUrl = isDm ? dmDeepLink(channel.id) : channelDeepLink(channel.slug);
          await publishBoltEvent(
            'channel.created',
            'banter',
            {
              channel: {
                id: channel.id,
                name: channel.name,
                handle: channel.slug,
                type: channel.type,
                description: channel.description,
                member_count: channel.member_count,
                url: channelUrl,
              },
              actor: enrichedActor,
              org: enrichedOrg,
            },
            user.org_id,
            user.id,
            'user',
          );
        } catch {
          // Fire-and-forget — never affect channel creation
        }
      })();

      return reply.status(201).send({ data: channel });
    },
  );

  // GET /v1/channels/browse — list all public channels
  fastify.get(
    '/v1/channels/browse',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;

      const channels = await db
        .select()
        .from(banterChannels)
        .where(
          and(
            eq(banterChannels.org_id, user.org_id),
            eq(banterChannels.type, 'public'),
            eq(banterChannels.is_archived, false),
          ),
        )
        .orderBy(banterChannels.name);

      return reply.send({ data: channels });
    },
  );

  // GET /v1/channels/by-name/:name — resolve channel by name, slug, or handle
  //
  // Read-only "resolver" endpoint used by MCP tooling so callers can
  // translate a human-friendly handle (general, #general, some-slug)
  // into a stable channel id without having to guess between name/slug
  // or scan the list endpoint. The caller is expected to strip any
  // leading '#'. Scoped to the authenticated user's active org; returns
  // `{ data: null }` for private channels the user cannot see.
  fastify.get(
    '/v1/channels/by-name/:name',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { name } = request.params as { name: string };
      const user = request.user!;

      // Normalize: strip a leading '#' if present, lowercase for slug match.
      const cleaned = (name ?? '').replace(/^#/, '').trim();
      if (!cleaned || cleaned.length > 80) {
        return reply.send({ data: null });
      }
      const slugCandidate = cleaned.toLowerCase();

      // Try slug first (canonical), then name (case-insensitive fallback).
      const [channel] = await db
        .select()
        .from(banterChannels)
        .where(
          and(
            eq(banterChannels.org_id, user.org_id),
            or(
              eq(banterChannels.slug, slugCandidate),
              sql`lower(${banterChannels.name}) = ${slugCandidate}`,
            ),
          ),
        )
        .limit(1);

      if (!channel) {
        return reply.send({ data: null });
      }

      // Private channel isolation: hide membership-less hits (treat as null).
      if (channel.type === 'private') {
        const [membership] = await db
          .select({ id: banterChannelMemberships.id })
          .from(banterChannelMemberships)
          .where(
            and(
              eq(banterChannelMemberships.channel_id, channel.id),
              eq(banterChannelMemberships.user_id, user.id),
            ),
          )
          .limit(1);

        if (!membership) {
          return reply.send({ data: null });
        }
      }

      // Shape the payload to match the MCP resolver contract.
      return reply.send({
        data: {
          id: channel.id,
          name: channel.name,
          handle: channel.slug,
          type: channel.type,
          description: channel.description,
        },
      });
    },
  );

  // GET /v1/channels/:id — channel detail (accepts UUID id or slug)
  fastify.get(
    '/v1/channels/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      // Support lookup by UUID or slug
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
      const condition = isUuid
        ? and(eq(banterChannels.id, id), eq(banterChannels.org_id, user.org_id))
        : and(eq(banterChannels.slug, id), eq(banterChannels.org_id, user.org_id));

      const [channel] = await db
        .select()
        .from(banterChannels)
        .where(condition)
        .limit(1);

      if (!channel) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Channel not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Private channel isolation: verify the requesting user is a member.
      // Return 404 (not 403) to avoid leaking that the channel exists.
      if (channel.type === 'private') {
        const [membership] = await db
          .select({ id: banterChannelMemberships.id })
          .from(banterChannelMemberships)
          .where(
            and(
              eq(banterChannelMemberships.channel_id, channel.id),
              eq(banterChannelMemberships.user_id, user.id),
            ),
          )
          .limit(1);

        if (!membership) {
          return reply.status(404).send({
            error: {
              code: 'NOT_FOUND',
              message: 'Channel not found',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      // Resolve the DM "other participant" so the detail view can show
      // the counterparty's name/avatar instead of the stored `name`
      // field (which is relative to the creator's perspective).
      let dm_other_participant: {
        id: string;
        display_name: string;
        avatar_url: string | null;
      } | null = null;
      if (channel.type === 'dm') {
        const [other] = await db
          .select({
            id: users.id,
            display_name: users.display_name,
            avatar_url: users.avatar_url,
            last_seen_at: users.last_seen_at,
          })
          .from(banterChannelMemberships)
          .innerJoin(users, eq(users.id, banterChannelMemberships.user_id))
          .where(
            and(
              eq(banterChannelMemberships.channel_id, channel.id),
              ne(banterChannelMemberships.user_id, user.id),
            ),
          )
          .limit(1);
        if (other) {
          dm_other_participant = {
            id: other.id,
            display_name: other.display_name,
            avatar_url: other.avatar_url,
            presence: derivePresence(other.last_seen_at),
          };
        }
      }

      return reply.send({ data: { ...channel, dm_other_participant } });
    },
  );

  // PATCH /v1/channels/:id — update settings
  fastify.patch(
    '/v1/channels/:id',
    { preHandler: [requireAuth, requireScope('read_write'), requireChannelMember, requireChannelAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = updateChannelSchema.parse(request.body);

      const updateData: Record<string, unknown> = {};
      if (body.name !== undefined) {
        updateData.name = body.name;
        updateData.slug = body.name.toLowerCase().replace(/\s+/g, '-');
      }
      if (body.display_name !== undefined) updateData.display_name = body.display_name;
      if (body.topic !== undefined) updateData.topic = body.topic;
      if (body.description !== undefined) updateData.description = body.description;
      if (body.icon !== undefined) updateData.icon = body.icon;
      if (body.channel_group_id !== undefined) updateData.channel_group_id = body.channel_group_id;
      if (body.allow_bots !== undefined) updateData.allow_bots = body.allow_bots;
      if (body.allow_huddles !== undefined) updateData.allow_huddles = body.allow_huddles;
      if (body.message_retention_days !== undefined)
        updateData.message_retention_days = body.message_retention_days;

      const [updated] = await db
        .update(banterChannels)
        .set(updateData)
        .where(eq(banterChannels.id, id))
        .returning();

      broadcastToChannel(id, {
        type: 'channel.updated',
        data: { channel: updated },
        timestamp: new Date().toISOString(),
      });

      return reply.send({ data: updated });
    },
  );

  // DELETE /v1/channels/:id — soft delete (archive)
  //
  // P0-18: The middleware chain (requireChannelMember + requireChannelOwner)
  // verifies ownership, but there is a TOCTOU window between the middleware
  // check and the UPDATE below. A concurrent request could demote/remove the
  // caller as owner in that window, and the archive would still complete.
  //
  // To close the race we perform an atomic conditional UPDATE that re-checks
  // ownership at the database layer. Org-level owner/admin and superusers
  // bypass this check (they moderate without needing a channel membership).
  fastify.delete(
    '/v1/channels/:id',
    { preHandler: [requireAuth, requireScope('read_write'), requireChannelMember, requireChannelOwner] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const isOrgPrivileged =
        user.is_superuser || user.role === 'owner' || user.role === 'admin';

      // Conditional archive: for regular channel owners, require a live
      // owner-role membership row at UPDATE time. Org-privileged users skip
      // the ownership re-check (they don't need a membership to moderate).
      const whereCondition = isOrgPrivileged
        ? eq(banterChannels.id, id)
        : and(
            eq(banterChannels.id, id),
            sql`EXISTS (
              SELECT 1 FROM banter_channel_memberships
              WHERE channel_id = ${id}
                AND user_id = ${user.id}
                AND role = 'owner'
            )`,
          );

      const [archived] = await db
        .update(banterChannels)
        .set({ is_archived: true })
        .where(whereCondition)
        .returning();

      if (!archived) {
        // Ownership was revoked between middleware check and UPDATE.
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Channel ownership was revoked — deletion aborted',
            details: [],
            request_id: request.id,
          },
        });
      }

      broadcastToOrg(user.org_id, {
        type: 'channel.archived',
        data: { channel: archived },
        timestamp: new Date().toISOString(),
      });

      return reply.send({ data: archived });
    },
  );

  // POST /v1/channels/:id/join — join public channel
  fastify.post(
    '/v1/channels/:id/join',
    { preHandler: [requireAuth, requireMinRole('member'), requireScope('read_write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const [channel] = await db
        .select()
        .from(banterChannels)
        .where(
          and(
            eq(banterChannels.id, id),
            eq(banterChannels.org_id, user.org_id),
            eq(banterChannels.is_archived, false),
          ),
        )
        .limit(1);

      if (!channel) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Channel not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      if (channel.type !== 'public') {
        return reply.status(403).send({
          error: {
            code: 'FORBIDDEN',
            message: 'Can only join public channels',
            details: [],
            request_id: request.id,
          },
        });
      }

      // Check if already a member
      const [existing] = await db
        .select()
        .from(banterChannelMemberships)
        .where(
          and(
            eq(banterChannelMemberships.channel_id, id),
            eq(banterChannelMemberships.user_id, user.id),
          ),
        )
        .limit(1);

      if (existing) {
        return reply.send({ data: { channel_id: id, user_id: user.id, already_member: true } });
      }

      await db.transaction(async (tx) => {
        await tx.insert(banterChannelMemberships).values({
          channel_id: id,
          user_id: user.id,
          role: 'member',
        }).onConflictDoNothing();

        // Recompute member_count from authoritative source to avoid drift
        // under concurrent join/leave operations.
        await tx
          .update(banterChannels)
          .set({
            member_count: sql`(SELECT COUNT(*)::int FROM banter_channel_memberships WHERE channel_id = ${id})`,
          })
          .where(eq(banterChannels.id, id));
      });

      broadcastToChannel(id, {
        type: 'member.joined',
        data: { channel_id: id, user_id: user.id, display_name: user.display_name },
        timestamp: new Date().toISOString(),
      });

      return reply.send({
        data: { channel_id: id, user_id: user.id, already_member: false },
      });
    },
  );

  // POST /v1/channels/:id/leave — leave channel
  //
  // P3-3: Any authenticated user — including guests — is allowed to leave
  // any channel they are currently a member of. The delete is keyed on
  // (channel_id, current user id), so the caller can only remove
  // themselves. The ONE exception: if the caller is the only owner AND the
  // channel still has other members, reject with LAST_OWNER_CANNOT_LEAVE
  // so the channel doesn't become ownerless. If the caller is the only
  // member (owner or otherwise), allow the leave — the channel becomes
  // orphaned but a later cleanup task can archive it.
  fastify.post(
    '/v1/channels/:id/leave',
    { preHandler: [requireAuth, requireScope('read_write')] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      // Look up caller's membership before attempting removal.
      const [callerMembership] = await db
        .select({ role: banterChannelMemberships.role })
        .from(banterChannelMemberships)
        .where(
          and(
            eq(banterChannelMemberships.channel_id, id),
            eq(banterChannelMemberships.user_id, user.id),
          ),
        )
        .limit(1);

      if (callerMembership?.role === 'owner') {
        const [totalRow] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(banterChannelMemberships)
          .where(eq(banterChannelMemberships.channel_id, id));

        const [otherOwnersRow] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(banterChannelMemberships)
          .where(
            and(
              eq(banterChannelMemberships.channel_id, id),
              eq(banterChannelMemberships.role, 'owner'),
              ne(banterChannelMemberships.user_id, user.id),
            ),
          );

        const totalMembers = totalRow?.count ?? 0;
        const otherOwners = otherOwnersRow?.count ?? 0;

        // Only block if leaving would leave the channel ownerless AND
        // there are still other members. If caller is the only member,
        // allow leave — the channel becomes orphaned (cleanup out of scope).
        if (otherOwners === 0 && totalMembers > 1) {
          return reply.status(400).send({
            error: {
              code: 'LAST_OWNER_CANNOT_LEAVE',
              message:
                'You are the only owner of this channel. Transfer ownership to another member before leaving.',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      const deleted = await db.transaction(async (tx) => {
        const removed = await tx
          .delete(banterChannelMemberships)
          .where(
            and(
              eq(banterChannelMemberships.channel_id, id),
              eq(banterChannelMemberships.user_id, user.id),
            ),
          )
          .returning();

        if (removed.length > 0) {
          await tx
            .update(banterChannels)
            .set({
              member_count: sql`(SELECT COUNT(*)::int FROM banter_channel_memberships WHERE channel_id = ${id})`,
            })
            .where(eq(banterChannels.id, id));
        }

        return removed;
      });

      if (deleted.length > 0) {
        broadcastToChannel(id, {
          type: 'member.left',
          data: { channel_id: id, user_id: user.id },
          timestamp: new Date().toISOString(),
        });
      }

      return reply.send({ data: { success: true } });
    },
  );

  // GET /v1/channels/:id/members — list members
  fastify.get(
    '/v1/channels/:id/members',
    { preHandler: [requireAuth, requireChannelMember] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const members = await db
        .select({
          id: banterChannelMemberships.id,
          user_id: users.id,
          display_name: users.display_name,
          email: users.email,
          avatar_url: users.avatar_url,
          role: banterChannelMemberships.role,
          joined_at: banterChannelMemberships.joined_at,
          is_muted: banterChannelMemberships.is_muted,
        })
        .from(banterChannelMemberships)
        .innerJoin(users, eq(banterChannelMemberships.user_id, users.id))
        .where(eq(banterChannelMemberships.channel_id, id))
        .orderBy(banterChannelMemberships.joined_at);

      return reply.send({ data: members });
    },
  );

  // POST /v1/channels/:id/members — add members
  fastify.post(
    '/v1/channels/:id/members',
    { preHandler: [requireAuth, requireScope('read_write'), requireChannelMember, requireChannelAdmin] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = addMembersSchema.parse(request.body);

      // Insert memberships (ignore conflicts) and recompute member_count atomically.
      const addedCount = await db.transaction(async (tx) => {
        let count = 0;
        for (const userId of body.user_ids) {
          try {
            const inserted = await tx
              .insert(banterChannelMemberships)
              .values({
                channel_id: id,
                user_id: userId,
                role: 'member',
              })
              .onConflictDoNothing()
              .returning();
            if (inserted.length > 0) count++;
          } catch {
            // Skip users that don't exist
          }
        }

        if (count > 0) {
          await tx
            .update(banterChannels)
            .set({
              member_count: sql`(SELECT COUNT(*)::int FROM banter_channel_memberships WHERE channel_id = ${id})`,
            })
            .where(eq(banterChannels.id, id));
        }

        return count;
      });

      return reply.send({ data: { added: addedCount } });
    },
  );

  // DELETE /v1/channels/:id/members/:userId — remove member
  fastify.delete(
    '/v1/channels/:id/members/:userId',
    { preHandler: [requireAuth, requireScope('read_write'), requireChannelMember, requireChannelAdmin] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };

      const deleted = await db.transaction(async (tx) => {
        const removed = await tx
          .delete(banterChannelMemberships)
          .where(
            and(
              eq(banterChannelMemberships.channel_id, id),
              eq(banterChannelMemberships.user_id, userId),
            ),
          )
          .returning();

        if (removed.length > 0) {
          await tx
            .update(banterChannels)
            .set({
              member_count: sql`(SELECT COUNT(*)::int FROM banter_channel_memberships WHERE channel_id = ${id})`,
            })
            .where(eq(banterChannels.id, id));
        }

        return removed;
      });

      if (deleted.length > 0) {
        broadcastToChannel(id, {
          type: 'member.left',
          data: { channel_id: id, user_id: userId },
          timestamp: new Date().toISOString(),
        });
      }

      return reply.send({ data: { success: true } });
    },
  );

  // PATCH /v1/channels/:id/members/:userId — update member role
  fastify.patch(
    '/v1/channels/:id/members/:userId',
    { preHandler: [requireAuth, requireScope('read_write'), requireChannelMember, requireChannelOwner] },
    async (request, reply) => {
      const { id, userId } = request.params as { id: string; userId: string };
      const body = z.object({ role: z.enum(['admin', 'member']) }).parse(request.body);

      // Verify target membership exists
      const [targetMembership] = await db
        .select()
        .from(banterChannelMemberships)
        .where(
          and(
            eq(banterChannelMemberships.channel_id, id),
            eq(banterChannelMemberships.user_id, userId),
          ),
        )
        .limit(1);

      if (!targetMembership) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Member not found in this channel',
            details: [],
            request_id: request.id,
          },
        });
      }

      // When demoting an owner, ensure at least one other owner remains.
      if (targetMembership.role === 'owner') {
        const [ownerCountRow] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(banterChannelMemberships)
          .where(
            and(
              eq(banterChannelMemberships.channel_id, id),
              eq(banterChannelMemberships.role, 'owner'),
              ne(banterChannelMemberships.user_id, userId),
            ),
          );

        const otherOwners = ownerCountRow?.count ?? 0;
        if (otherOwners === 0) {
          return reply.status(400).send({
            error: {
              code: 'BAD_REQUEST',
              message: 'Cannot demote the last owner of the channel. Transfer ownership first.',
              details: [],
              request_id: request.id,
            },
          });
        }
      }

      const [updated] = await db
        .update(banterChannelMemberships)
        .set({ role: body.role })
        .where(eq(banterChannelMemberships.id, targetMembership.id))
        .returning();

      broadcastToChannel(id, {
        type: 'member.role_updated',
        data: { channel_id: id, user_id: userId, role: body.role },
        timestamp: new Date().toISOString(),
      });

      return reply.send({ data: updated });
    },
  );

  // POST /v1/channels/:id/mark-read — update last_read_message_id
  fastify.post(
    '/v1/channels/:id/mark-read',
    { preHandler: [requireAuth, requireChannelMember] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      const body = markReadSchema.parse(request.body);

      await db
        .update(banterChannelMemberships)
        .set({
          last_read_message_id: body.message_id,
          last_read_at: new Date(),
        })
        .where(
          and(
            eq(banterChannelMemberships.channel_id, id),
            eq(banterChannelMemberships.user_id, user.id),
          ),
        );

      return reply.send({ data: { success: true } });
    },
  );
}
