import type { FastifyRequest, FastifyReply } from 'fastify';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { banterChannels, banterChannelMemberships } from '../db/schema/index.js';

type ChannelRow = typeof banterChannels.$inferSelect;
type MembershipRow = typeof banterChannelMemberships.$inferSelect;

declare module 'fastify' {
  interface FastifyRequest {
    channelContext?: {
      channel: ChannelRow;
      membership: MembershipRow;
    };
  }
}

/**
 * Extracts channel ID from route params (`:id` or `:channelId`)
 * and verifies the user is a member. Attaches channel and membership
 * to `request.channelContext` for downstream use.
 *
 * - If the channel doesn't exist or doesn't belong to the user's org: 404
 * - If the channel is archived: 404 (archived channels are invisible to members;
 *   they must be un-archived to interact). SuperUsers bypass this check.
 * - If the channel is private and the user isn't a member: 404 (to avoid leaking existence)
 * - If the channel is public/other and the user isn't a member: 403
 */
export async function requireChannelMember(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user!;
  const params = request.params as Record<string, string>;
  const channelId = params.id ?? params.channelId;

  if (!channelId) {
    return reply.status(400).send({
      error: {
        code: 'BAD_REQUEST',
        message: 'Missing channel ID in route params',
        details: [],
        request_id: request.id,
      },
    });
  }

  const [channel] = await db
    .select()
    .from(banterChannels)
    .where(and(eq(banterChannels.id, channelId), eq(banterChannels.org_id, user.org_id)))
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

  // Archived channels are invisible to regular users (including members).
  // SuperUsers bypass this check so they can inspect/un-archive.
  if (channel.is_archived && !user.is_superuser) {
    return reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'Channel not found',
        details: [],
        request_id: request.id,
      },
    });
  }

  // SuperUsers bypass channel membership requirement
  if (user.is_superuser) {
    request.channelContext = {
      channel,
      membership: { role: 'owner' } as MembershipRow,
    };
    return;
  }

  const [membership] = await db
    .select()
    .from(banterChannelMemberships)
    .where(
      and(
        eq(banterChannelMemberships.channel_id, channelId),
        eq(banterChannelMemberships.user_id, user.id),
      ),
    )
    .limit(1);

  if (!membership) {
    // PUBLIC channels are org-readable: any member of the org (org match was
    // enforced in the channel lookup above) may read AND post without joining,
    // via a synthesized non-admin context. No auto-join — joining the sidebar
    // stays an explicit action; the Feed's followed/unfollowed subscription
    // controls what surfaces. Admin actions remain gated: requireChannelAdmin
    // runs after this and a synthesized 'member' role does not satisfy it.
    if (channel.type === 'public') {
      request.channelContext = {
        channel,
        membership: { role: 'member' } as MembershipRow,
      };
      return;
    }

    // Private channels: return 404 to avoid leaking existence.
    return reply.status(404).send({
      error: {
        code: 'NOT_FOUND',
        message: 'Channel not found',
        details: [],
        request_id: request.id,
      },
    });
  }

  request.channelContext = { channel, membership };
}

/**
 * Requires the user to be a channel admin or owner, or an org-level admin/owner,
 * or a superuser. Must be called after `requireChannelMember`.
 */
export async function requireChannelAdmin(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user!;
  const ctx = request.channelContext;

  if (!ctx) {
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'requireChannelAdmin must be used after requireChannelMember',
        details: [],
        request_id: request.id,
      },
    });
  }

  // Superuser or org-level admin/owner bypasses channel role check.
  // NOTE (P2-15): this only elevates org admins/owners who are already
  // channel members — `requireChannelMember` (the required predecessor)
  // blocks non-member org admins. See docs/permissions-audit-findings.md P2-15.
  if (user.is_superuser || ['owner', 'admin'].includes(user.role)) {
    return;
  }

  if (['owner', 'admin'].includes(ctx.membership.role)) {
    return;
  }

  return reply.status(403).send({
    error: {
      code: 'FORBIDDEN',
      message: 'Insufficient permissions — channel admin or owner required',
      details: [],
      request_id: request.id,
    },
  });
}

/**
 * Requires the user to be the channel owner, or an org-level owner, or a superuser.
 * Must be called after `requireChannelMember`.
 */
export async function requireChannelOwner(request: FastifyRequest, reply: FastifyReply) {
  const user = request.user!;
  const ctx = request.channelContext;

  if (!ctx) {
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'requireChannelOwner must be used after requireChannelMember',
        details: [],
        request_id: request.id,
      },
    });
  }

  // Superuser or org-level owner bypasses channel role check
  if (user.is_superuser || user.role === 'owner') {
    return;
  }

  if (ctx.membership.role === 'owner') {
    return;
  }

  return reply.status(403).send({
    error: {
      code: 'FORBIDDEN',
      message: 'Insufficient permissions — channel owner required',
      details: [],
      request_id: request.id,
    },
  });
}
