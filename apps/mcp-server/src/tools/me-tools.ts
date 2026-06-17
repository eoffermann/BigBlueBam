import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { registerTool } from '../lib/register-tool.js';

/**
 * Tools wrapping /auth/me, /auth/orgs, /auth/switch-org, /auth/logout,
 * /auth/change-password and the /me/notifications feed. These map to the
 * "what can *I* do about *me*" surface — profile, org membership, session,
 * notification inbox.
 */
export function registerMeTools(server: McpServer, api: ApiClient): void {
  registerTool(server, {
    name: 'get_me',
    description: 'Get the authenticated user profile (display name, email, avatar, timezone, notification preferences, active org, superuser flag).',
    input: {},
    returns: z.object({
      id: z.string().uuid(),
      email: z.string(),
      display_name: z.string(),
      avatar_url: z.string().nullable().optional(),
      timezone: z.string().optional(),
      is_superuser: z.boolean().optional(),
      active_org_id: z.string().uuid().nullable().optional(),
    }).passthrough(),
    handler: async () => {
      const result = await api.get('/auth/me');
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error fetching profile: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  registerTool(server, {
    name: 'update_me',
    description: "Update the authenticated user's own profile fields.",
    input: {
      display_name: z.string().min(1).max(200).optional().describe('Display name shown across Bam.'),
      avatar_url: z.string().url().nullable().optional().describe('Avatar URL, or null to clear.'),
      timezone: z.string().optional().describe('IANA timezone (e.g. America/New_York).'),
      notification_prefs: z.record(z.unknown()).optional().describe('JSON object of notification preferences.'),
    },
    returns: z.object({
      id: z.string().uuid(),
      display_name: z.string(),
      avatar_url: z.string().nullable().optional(),
      timezone: z.string().optional(),
    }).passthrough(),
    handler: async (body) => {
      const result = await api.patch('/auth/me', body);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error updating profile: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  registerTool(server, {
    name: 'get_my_org',
    description:
      "Read the caller's active organization metadata — name, slug, plan, logo, free-form settings JSONB, plus live counts (active_owner_count, member_count) used by the People UI. This is the org-level analog of get_me: it tells you which org downstream calls are scoped to and basic facts about it. Read-only; use platform_get_org (SuperUser) for a different org by id, or switch_active_org first to change scope.",
    input: {},
    returns: z
      .object({
        data: z
          .object({
            id: z.string().uuid(),
            name: z.string(),
            slug: z.string().optional(),
            plan: z.string().optional(),
            logo_url: z.string().nullable().optional(),
            settings: z.record(z.unknown()).nullable().optional(),
            active_owner_count: z.number().int().optional(),
            member_count: z.number().int().optional(),
            created_at: z.string().optional(),
          })
          .passthrough(),
      })
      .passthrough(),
    handler: async () => {
      const result = await api.get('/org');
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error fetching org: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  registerTool(server, {
    name: 'list_my_orgs',
    description: 'List organizations the authenticated user is a member of, including role in each.',
    input: {},
    returns: z.object({
      data: z.array(z.object({
        id: z.string().uuid(),
        name: z.string(),
        role: z.string(),
      }).passthrough()),
    }),
    handler: async () => {
      const result = await api.get('/auth/orgs');
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error listing orgs: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  registerTool(server, {
    name: 'switch_active_org',
    description: 'Switch the active organization for the current session. Affects which projects/members/tickets are returned by downstream calls.',
    input: {
      org_id: z.string().uuid().describe('Target organization ID — must be one of the caller\'s memberships.'),
    },
    returns: z.object({ ok: z.boolean(), active_org_id: z.string().uuid().optional() }).passthrough(),
    handler: async ({ org_id }) => {
      const result = await api.post('/auth/switch-org', { org_id });
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error switching org: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  registerTool(server, {
    name: 'change_my_password',
    description: "Change the authenticated user's password. Requires the current password.",
    input: {
      current_password: z.string().min(1).describe('Current password.'),
      new_password: z.string().min(12).describe('New password (min 12 chars).'),
    },
    returns: z.object({ ok: z.boolean() }),
    handler: async (body) => {
      const result = await api.post('/auth/change-password', body);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error changing password: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  registerTool(server, {
    name: 'logout',
    description: 'Invalidate the current session cookie. Note: API-key callers are not affected — this only logs out cookie sessions.',
    input: {},
    returns: z.object({ ok: z.boolean() }),
    handler: async () => {
      const result = await api.post('/auth/logout', {});
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error logging out: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  registerTool(server, {
    name: 'list_my_notifications',
    description: "Fetch the caller's notification feed (paginated, cursor-based).",
    input: {
      cursor: z.string().optional().describe('Pagination cursor.'),
      limit: z.number().int().positive().max(200).optional().describe('Page size (default 50).'),
      unread_only: z.boolean().optional().describe('Only return unread notifications.'),
      category: z.string().optional().describe('Filter by category (e.g. mention, assignment).'),
      source_app: z.string().optional().describe('Filter by source app (bbb, banter, helpdesk).'),
    },
    returns: z.object({
      data: z.array(z.object({
        id: z.string().uuid(),
        category: z.string().optional(),
        title: z.string().optional(),
        read_at: z.string().nullable().optional(),
        created_at: z.string(),
      }).passthrough()),
      next_cursor: z.string().nullable().optional(),
    }),
    handler: async ({ cursor, limit, unread_only, category, source_app }) => {
      const params = new URLSearchParams();
      if (cursor) params.set('cursor', cursor);
      if (limit) params.set('limit', String(limit));
      if (unread_only) params.set('unread_only', 'true');
      if (category) params.set('category', category);
      if (source_app) params.set('source_app', source_app);
      const qs = params.toString();
      const result = await api.get(`/me/notifications${qs ? `?${qs}` : ''}`);
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error fetching notifications: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  registerTool(server, {
    name: 'mark_notification_read',
    description: 'Mark a single notification as read.',
    input: {
      notification_id: z.string().uuid().describe('Notification ID.'),
    },
    returns: z.object({ ok: z.boolean() }),
    handler: async ({ notification_id }) => {
      const result = await api.post(`/me/notifications/${notification_id}/read`, {});
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error marking notification read: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  registerTool(server, {
    name: 'mark_notifications_read',
    description: 'Mark several notifications as read in one call.',
    input: {
      notification_ids: z.array(z.string().uuid()).min(1).max(500).describe('List of notification IDs to mark read.'),
    },
    returns: z.object({ ok: z.boolean(), updated: z.number().optional() }),
    handler: async ({ notification_ids }) => {
      const result = await api.post('/me/notifications/mark-read', { notification_ids });
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error marking notifications read: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });

  registerTool(server, {
    name: 'mark_all_notifications_read',
    description: "Mark every notification in the caller's feed as read.",
    input: {},
    returns: z.object({ ok: z.boolean(), updated: z.number().optional() }),
    handler: async () => {
      const result = await api.post('/me/notifications/mark-all-read', {});
      if (!result.ok) {
        return {
          content: [{ type: 'text' as const, text: `Error marking all notifications read: ${JSON.stringify(result.data)}` }],
          isError: true,
        };
      }
      return { content: [{ type: 'text' as const, text: JSON.stringify(result.data, null, 2) }] };
    },
  });
}
