import { registerTool } from '../lib/register-tool.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { ApiClient } from '../middleware/api-client.js';
import { isUuid } from '../middleware/resolve-helpers.js';
import { handleScopeError } from '../middleware/scope-check.js';

/**
 * Helper to make requests to the banter-api service.
 * Similar pattern to helpdesk-tools.ts — a lightweight fetch wrapper
 * that targets the banter-api base URL and forwards the user's auth token.
 */
function createBanterClient(banterApiUrl: string, api: ApiClient) {
  const baseUrl = banterApiUrl.replace(/\/$/, '');

  async function request(method: string, path: string, body?: unknown) {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {};

    // Forward the bearer token from the main API client
    const token = (api as unknown as { token?: string }).token;
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }

    try {
      const res = await fetch(url, init);
      // Tolerate empty (204 No Content) and non-JSON bodies so DELETE/204 tools
      // report success instead of throwing "Unexpected end of JSON input".
      const __text = await res.text();
      let data: unknown = null;
      if (__text) {
        try {
          data = JSON.parse(__text);
        } catch {
          data = __text;
        }
      }
      return { ok: res.ok, status: res.status, data };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        data: { error: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  }

  return {
    get: (path: string) => request('GET', path),
    post: (path: string, body?: unknown) => request('POST', path, body),
    patch: (path: string, body?: unknown) => request('PATCH', path, body),
    delete: (path: string) => request('DELETE', path),
  };
}

/**
 * Minimal client shape the resolver helpers need. Matches the object returned
 * by `createBanterClient` above — we only want `get` here since every resolver
 * endpoint is read-only.
 */
type BanterClient = ReturnType<typeof createBanterClient>;

/**
 * Resolve a Banter channel identifier to a UUID.
 *
 * Accepts a UUID (short-circuited with no extra HTTP call), a bare channel
 * name / slug ("general"), or a `#name` form. Returns `null` if the channel
 * is not visible to the current caller — callers should surface a clean
 * "Channel not found" error in that case. This lets automation rules refer
 * to channels by their human-friendly name so "#general" never has to be
 * typed as a UUID in a rule step.
 */
async function resolveChannelId(
  banter: BanterClient,
  idOrName: string,
): Promise<string | null> {
  if (isUuid(idOrName)) return idOrName;
  const cleaned = idOrName.replace(/^#/, '').trim();
  if (!cleaned) return null;
  const result = await banter.get(
    `/v1/channels/by-name/${encodeURIComponent(cleaned)}`,
  );
  if (!result.ok) return null;
  const envelope = result.data as { data?: { id?: string } | null } | null;
  return envelope?.data?.id ?? null;
}

/**
 * Resolve a Banter user identifier to a UUID.
 *
 * Accepts a UUID, an email address (contains '@' somewhere not at the start),
 * or a handle (with or without a leading '@'). Returns `null` when no match
 * is found. Handles are slugified display names, matching Phase C's
 * `/v1/users/by-handle/:handle` endpoint.
 */
async function resolveUserId(
  banter: BanterClient,
  idOrEmailOrHandle: string,
): Promise<string | null> {
  if (isUuid(idOrEmailOrHandle)) return idOrEmailOrHandle;
  const trimmed = idOrEmailOrHandle.trim();
  if (!trimmed) return null;
  // Email path: contains '@' anywhere not at the start.
  if (trimmed.includes('@') && !trimmed.startsWith('@')) {
    const result = await banter.get(
      `/v1/users/by-email?email=${encodeURIComponent(trimmed)}`,
    );
    if (!result.ok) return null;
    const envelope = result.data as { data?: { id?: string } | null } | null;
    return envelope?.data?.id ?? null;
  }
  // Handle path: strip a leading '@' if present.
  const handle = trimmed.replace(/^@/, '').trim();
  if (!handle) return null;
  const result = await banter.get(
    `/v1/users/by-handle/${encodeURIComponent(handle)}`,
  );
  if (!result.ok) return null;
  const envelope = result.data as { data?: { id?: string } | null } | null;
  return envelope?.data?.id ?? null;
}

function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

function err(label: string, data: unknown) {
  return {
    content: [{ type: 'text' as const, text: `Error ${label}: ${JSON.stringify(data)}` }],
    isError: true,
  };
}

/** Return a scope-aware error for write operations, falling back to the standard err(). */
function writeErr(toolName: string, label: string, result: { ok: boolean; status: number; data: unknown }) {
  const scopeResult = handleScopeError(toolName, 'read_write', result);
  if (scopeResult) return scopeResult;
  return err(label, result.data);
}

const channelShape = z.object({
  id: z.string().uuid(),
  name: z.string(),
  is_private: z.boolean().optional(),
  is_archived: z.boolean().optional(),
  description: z.string().nullable().optional(),
  topic: z.string().nullable().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

const messageShape = z.object({
  id: z.string().uuid(),
  channel_id: z.string().uuid().optional(),
  content: z.string(),
  user_id: z.string().uuid().optional(),
  created_at: z.string(),
  updated_at: z.string(),
}).passthrough();

const userGroupShape = z.object({
  id: z.string().uuid(),
  name: z.string(),
  handle: z.string(),
  description: z.string().nullable().optional(),
  created_at: z.string(),
}).passthrough();

const callShape = z.object({
  id: z.string().uuid(),
  channel_id: z.string().uuid().optional(),
  type: z.string().optional(),
  status: z.string().optional(),
  started_at: z.string().optional(),
  ended_at: z.string().nullable().optional(),
}).passthrough();

const banterUserShape = z.object({
  id: z.string().uuid(),
  email: z.string().optional(),
  name: z.string().optional(),
  display_name: z.string().nullable().optional(),
  avatar_url: z.string().nullable().optional(),
}).passthrough();

export function registerBanterTools(server: McpServer, api: ApiClient, banterApiUrl: string): void {
  const banter = createBanterClient(banterApiUrl, api);

  // ---------------------------------------------------------------------------
  // Channel tools (10)
  // ---------------------------------------------------------------------------

  registerTool(server, {
    name: 'banter_list_channels',
    description: 'List all Banter channels the current user has access to',
    input: {
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(100).optional().describe('Number of results'),
    },
    returns: z.object({ data: z.array(channelShape), next_cursor: z.string().nullable().optional() }),
    handler: async (params) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const q = qs.toString();
      const result = await banter.get(`/v1/channels${q ? `?${q}` : ''}`);
      return result.ok ? ok(result.data) : err('listing channels', result.data);
    },
  });

  registerTool(server, {
    name: 'banter_get_channel',
    description: 'Get detailed information about a Banter channel',
    input: {
      channel_id: z.string().uuid().describe('The channel ID'),
    },
    returns: channelShape,
    handler: async ({ channel_id }) => {
      const result = await banter.get(`/v1/channels/${channel_id}`);
      return result.ok ? ok(result.data) : err('getting channel', result.data);
    },
  });

  // Resolver: translate a human-friendly name/handle into a channel id.
  // Read-only, idempotent; returns null on miss rather than erroring so
  // callers can cheaply probe for existence.
  registerTool(server, {
    name: 'banter_get_channel_by_name',
    description: 'Resolve a Banter channel by name or handle. Accepts "general", "#general", or a slug. Returns the channel {id, name, handle, type, description} or null if not found.',
    input: {
      name_or_handle: z
        .string()
        .min(1)
        .describe('Channel name, handle, or slug. A leading "#" is accepted and stripped.'),
    },
    returns: z.object({ data: channelShape.nullable() }).passthrough(),
    handler: async ({ name_or_handle }) => {
      const cleaned = name_or_handle.replace(/^#/, '').trim();
      if (!cleaned) return ok({ data: null });
      const result = await banter.get(
        `/v1/channels/by-name/${encodeURIComponent(cleaned)}`,
      );
      return result.ok ? ok(result.data) : err('resolving channel by name', result.data);
    },
  });

  registerTool(server, {
    name: 'banter_create_channel',
    description: 'Create a new Banter channel',
    input: {
      name: z.string().min(1).max(80).describe('Channel name (lowercase, no spaces)'),
      description: z.string().optional().describe('Channel description'),
      topic: z.string().optional().describe('Channel topic'),
      is_private: z.boolean().optional().describe('Whether the channel is private (invite-only)'),
      group_id: z.string().uuid().optional().describe('Channel group ID for sidebar organization'),
    },
    returns: channelShape,
    handler: async (params) => {
      const result = await banter.post('/v1/channels', params);
      return result.ok ? ok(result.data) : writeErr('banter_create_channel', 'creating channel', result);
    },
  });

  registerTool(server, {
    name: 'banter_update_channel',
    description: 'Update a Banter channel name, description, or topic',
    input: {
      channel_id: z.string().uuid().describe('The channel ID'),
      name: z.string().min(1).max(80).optional().describe('New channel name'),
      description: z.string().optional().describe('New description'),
      topic: z.string().optional().describe('New topic'),
    },
    returns: channelShape,
    handler: async ({ channel_id, ...updates }) => {
      const result = await banter.patch(`/v1/channels/${channel_id}`, updates);
      return result.ok ? ok(result.data) : writeErr('banter_update_channel', 'updating channel', result);
    },
  });

  registerTool(server, {
    name: 'banter_archive_channel',
    description: 'Archive a Banter channel (reversible). Accepts a channel UUID, a bare channel name, or #name — no need to resolve the id first.',
    input: {
      channel_id: z
        .string()
        .min(1)
        .describe('Channel UUID, name, or #name to archive'),
    },
    returns: channelShape,
    handler: async ({ channel_id }) => {
      const resolved = await resolveChannelId(banter, channel_id);
      if (!resolved) {
        return err('Channel not found', `Channel '${channel_id}' could not be resolved`);
      }
      const result = await banter.patch(`/v1/channels/${resolved}`, { is_archived: true });
      return result.ok ? ok(result.data) : writeErr('banter_archive_channel', 'archiving channel', result);
    },
  });

  registerTool(server, {
    name: 'banter_delete_channel',
    description: 'Delete a Banter channel (destructive - requires confirmation)',
    input: {
      channel_id: z.string().uuid().describe('The channel ID to delete'),
      confirm_action: z.boolean().describe('Must be true to confirm deletion'),
    },
    returns: z.object({ ok: z.boolean(), message: z.string().optional() }),
    handler: async ({ channel_id, confirm_action }) => {
      if (!confirm_action) {
        return {
          content: [{
            type: 'text' as const,
            text: `Are you sure you want to delete channel ${channel_id}? Call this tool again with confirm_action: true to proceed.`,
          }],
        };
      }
      const result = await banter.delete(`/v1/channels/${channel_id}`);
      return result.ok
        ? { content: [{ type: 'text' as const, text: `Channel ${channel_id} deleted successfully.` }] }
        : writeErr('banter_delete_channel', 'deleting channel', result);
    },
  });

  registerTool(server, {
    name: 'banter_join_channel',
    description: 'Join a Banter channel. Accepts a channel UUID, a bare channel name, or #name.',
    input: {
      channel_id: z
        .string()
        .min(1)
        .describe('Channel UUID, name, or #name to join'),
    },
    returns: channelShape,
    handler: async ({ channel_id }) => {
      const resolved = await resolveChannelId(banter, channel_id);
      if (!resolved) {
        return err('Channel not found', `Channel '${channel_id}' could not be resolved`);
      }
      const result = await banter.post(`/v1/channels/${resolved}/join`);
      return result.ok ? ok(result.data) : writeErr('banter_join_channel', 'joining channel', result);
    },
  });

  registerTool(server, {
    name: 'banter_leave_channel',
    description: 'Leave a Banter channel',
    input: {
      channel_id: z.string().uuid().describe('The channel ID to leave'),
    },
    returns: z.object({ ok: z.boolean() }),
    handler: async ({ channel_id }) => {
      const result = await banter.post(`/v1/channels/${channel_id}/leave`);
      return result.ok ? ok(result.data) : writeErr('banter_leave_channel', 'leaving channel', result);
    },
  });

  registerTool(server, {
    name: 'banter_add_channel_members',
    description: 'Add one or more members to a Banter channel. Accepts a channel UUID, name, or #name, and each user may be a UUID, email, or @handle — mixed lists are supported.',
    input: {
      channel_id: z
        .string()
        .min(1)
        .describe('Channel UUID, name, or #name'),
      user_ids: z
        .array(z.string().min(1))
        .min(1)
        .describe('Users to add. Each element may be a UUID, email address, or @handle.'),
    },
    returns: z.object({ added: z.number(), members: z.array(z.string().uuid()).optional() }).passthrough(),
    handler: async ({ channel_id, user_ids }) => {
      const resolvedChannel = await resolveChannelId(banter, channel_id);
      if (!resolvedChannel) {
        return err('Channel not found', `Channel '${channel_id}' could not be resolved`);
      }
      const resolvedUsers = await Promise.all(
        user_ids.map((id) => resolveUserId(banter, id)),
      );
      const failed = user_ids.filter((_, i) => !resolvedUsers[i]);
      if (failed.length > 0) {
        return err('Users not found', `Could not resolve: ${failed.join(', ')}`);
      }
      const userIds = resolvedUsers.filter((id): id is string => id !== null);
      const result = await banter.post(
        `/v1/channels/${resolvedChannel}/members`,
        { user_ids: userIds },
      );
      return result.ok ? ok(result.data) : writeErr('banter_add_channel_members', 'adding channel members', result);
    },
  });

  registerTool(server, {
    name: 'banter_remove_channel_member',
    description: 'Remove a member from a Banter channel',
    input: {
      channel_id: z.string().uuid().describe('The channel ID'),
      user_id: z.string().uuid().describe('The user ID to remove'),
    },
    returns: z.object({ ok: z.boolean() }),
    handler: async ({ channel_id, user_id }) => {
      const result = await banter.delete(`/v1/channels/${channel_id}/members/${user_id}`);
      return result.ok
        ? { content: [{ type: 'text' as const, text: `User ${user_id} removed from channel ${channel_id}.` }] }
        : writeErr('banter_remove_channel_member', 'removing channel member', result);
    },
  });

  // ---------------------------------------------------------------------------
  // Message tools (8)
  // ---------------------------------------------------------------------------

  registerTool(server, {
    name: 'banter_list_messages',
    description: 'List messages in a Banter channel with pagination',
    input: {
      channel_id: z.string().uuid().describe('The channel ID'),
      cursor: z.string().optional().describe('Pagination cursor (message ID)'),
      limit: z.number().int().positive().max(100).optional().describe('Number of messages to fetch'),
      direction: z.enum(['before', 'after']).optional().describe('Pagination direction relative to cursor'),
    },
    returns: z.object({ data: z.array(messageShape), next_cursor: z.string().nullable().optional() }),
    handler: async ({ channel_id, ...params }) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const q = qs.toString();
      const result = await banter.get(`/v1/channels/${channel_id}/messages${q ? `?${q}` : ''}`);
      return result.ok ? ok(result.data) : err('listing messages', result.data);
    },
  });

  registerTool(server, {
    name: 'banter_get_message',
    description: 'Get a specific Banter message by ID',
    input: {
      message_id: z.string().uuid().describe('The message ID'),
    },
    returns: messageShape,
    handler: async ({ message_id }) => {
      const result = await banter.get(`/v1/messages/${message_id}`);
      return result.ok ? ok(result.data) : err('getting message', result.data);
    },
  });

  // §13 Wave 4 scheduled banter — shape for the scheduled-envelope branch of
  // the banter_post_message union return.
  const scheduledEnvelopeShape = z.object({
    scheduled: z.literal(true),
    scheduled_message_id: z.string().uuid(),
    scheduled_at: z.string(),
    defer_reason: z.string().nullable().optional(),
  }).passthrough();

  registerTool(server, {
    name: 'banter_post_message',
    description: 'Post a new message to a Banter channel. Accepts a channel UUID, a bare channel name, or #name. §13 Wave 4: optionally accepts scheduled_at (ISO-8601, max 30 days out), defer_if_quiet (convert to scheduled if channel is in quiet hours), and urgency_override (bypass quiet hours when both caller and channel policy consent). When a post is scheduled or deferred, the tool returns a scheduled envelope ({ scheduled: true, scheduled_message_id, scheduled_at, defer_reason }) instead of an immediate message.',
    input: {
      channel_id: z
        .string()
        .min(1)
        .describe('Channel UUID, name, or #name to post in'),
      content: z.string().min(1).describe('Message content (markdown supported)'),
      attachment_ids: z.array(z.string().uuid()).optional().describe('File attachment IDs'),
      // §13 Wave 4 scheduled banter
      scheduled_at: z
        .string()
        .datetime({ offset: true })
        .optional()
        .describe('Optional ISO-8601 future timestamp. Max 30 days out. If set, the post is scheduled (202) instead of posted immediately.'),
      defer_if_quiet: z
        .boolean()
        .optional()
        .describe('If true and the channel is currently in a quiet-hours window, convert this immediate post into a scheduled post at the next-allowed time instead of rejecting with 409.'),
      urgency_override: z
        .boolean()
        .optional()
        .describe('If true AND the channel policy.urgency_override flag is true, bypass the quiet-hours check. The caller cannot override unless the policy explicitly allows it.'),
    },
    returns: z.union([messageShape, scheduledEnvelopeShape]),
    handler: async ({ channel_id, ...body }) => {
      const resolved = await resolveChannelId(banter, channel_id);
      if (!resolved) {
        return err('Channel not found', `Channel '${channel_id}' could not be resolved`);
      }
      const result = await banter.post(`/v1/channels/${resolved}/messages`, body);
      return result.ok ? ok(result.data) : writeErr('banter_post_message', 'posting message', result);
    },
  });

  // §13 Wave 4 scheduled banter — dedicated scheduling alias.
  registerTool(server, {
    name: 'banter_schedule_post',
    description: 'Schedule a Banter post for future delivery. Thin wrapper over banter_post_message with scheduled_at REQUIRED. Returns the scheduled envelope { scheduled: true, scheduled_message_id, scheduled_at, defer_reason }. If respect_quiet_hours is true (default) the scheduled_at is honored as-is; if the channel is in quiet hours at fire time, the worker still delivers because scheduled posts are explicit. Use defer_if_quiet on banter_post_message to instead reschedule around a quiet-hours window at request time.',
    input: {
      channel_id: z
        .string()
        .min(1)
        .describe('Channel UUID, name, or #name to post in'),
      content: z.string().min(1).describe('Message content (markdown supported)'),
      scheduled_at: z
        .string()
        .datetime({ offset: true })
        .describe('ISO-8601 future timestamp (max 30 days out).'),
      attachment_ids: z.array(z.string().uuid()).optional().describe('File attachment IDs'),
      respect_quiet_hours: z
        .boolean()
        .optional()
        .default(true)
        .describe('Reserved for future use. Currently scheduled posts are delivered at scheduled_at regardless; use defer_if_quiet on banter_post_message for quiet-hours-aware immediate posts.'),
    },
    returns: scheduledEnvelopeShape,
    handler: async ({ channel_id, respect_quiet_hours: _respect, ...body }) => {
      const resolved = await resolveChannelId(banter, channel_id);
      if (!resolved) {
        return err('Channel not found', `Channel '${channel_id}' could not be resolved`);
      }
      const result = await banter.post(`/v1/channels/${resolved}/messages`, body);
      return result.ok ? ok(result.data) : writeErr('banter_schedule_post', 'scheduling message', result);
    },
  });

  registerTool(server, {
    name: 'banter_edit_message',
    description: 'Edit an existing Banter message',
    input: {
      message_id: z.string().uuid().describe('The message ID to edit'),
      content: z.string().min(1).describe('New message content'),
    },
    returns: messageShape,
    handler: async ({ message_id, content }) => {
      const result = await banter.patch(`/v1/messages/${message_id}`, { content });
      return result.ok ? ok(result.data) : writeErr('banter_edit_message', 'editing message', result);
    },
  });

  registerTool(server, {
    name: 'banter_delete_message',
    description: 'Delete a Banter message (destructive - requires confirmation)',
    input: {
      message_id: z.string().uuid().describe('The message ID to delete'),
      confirm: z.boolean().describe('Must be true to confirm deletion'),
    },
    returns: z.object({ ok: z.boolean() }),
    handler: async ({ message_id, confirm }) => {
      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: `Are you sure you want to delete message ${message_id}? Call this tool again with confirm: true to proceed.`,
          }],
        };
      }
      const result = await banter.delete(`/v1/messages/${message_id}`);
      return result.ok
        ? { content: [{ type: 'text' as const, text: `Message ${message_id} deleted successfully.` }] }
        : writeErr('banter_delete_message', 'deleting message', result);
    },
  });

  registerTool(server, {
    name: 'banter_react',
    description: 'Add or remove an emoji reaction on a Banter message',
    input: {
      message_id: z.string().uuid().describe('The message ID'),
      emoji: z.string().min(1).describe('Emoji to react with (e.g. "+1", "fire", "heart")'),
    },
    returns: z.object({ message_id: z.string().uuid(), emoji: z.string(), toggled: z.boolean().optional() }).passthrough(),
    handler: async ({ message_id, emoji }) => {
      const result = await banter.post(`/v1/messages/${message_id}/reactions`, { emoji });
      return result.ok ? ok(result.data) : writeErr('banter_react', 'reacting to message', result);
    },
  });

  registerTool(server, {
    name: 'banter_pin_message',
    description: 'Pin a message in a Banter channel. Accepts a channel UUID, name, or #name.',
    input: {
      channel_id: z
        .string()
        .min(1)
        .describe('Channel UUID, name, or #name'),
      message_id: z.string().uuid().describe('The message ID to pin'),
    },
    returns: z.object({ channel_id: z.string().uuid(), message_id: z.string().uuid() }).passthrough(),
    handler: async ({ channel_id, message_id }) => {
      const resolved = await resolveChannelId(banter, channel_id);
      if (!resolved) {
        return err('Channel not found', `Channel '${channel_id}' could not be resolved`);
      }
      const result = await banter.post(`/v1/channels/${resolved}/pins`, { message_id });
      return result.ok ? ok(result.data) : writeErr('banter_pin_message', 'pinning message', result);
    },
  });

  registerTool(server, {
    name: 'banter_unpin_message',
    description: 'Unpin a message from a Banter channel. Accepts a channel UUID, name, or #name.',
    input: {
      channel_id: z
        .string()
        .min(1)
        .describe('Channel UUID, name, or #name'),
      message_id: z.string().uuid().describe('The message ID to unpin'),
    },
    returns: z.object({ ok: z.boolean() }),
    handler: async ({ channel_id, message_id }) => {
      const resolved = await resolveChannelId(banter, channel_id);
      if (!resolved) {
        return err('Channel not found', `Channel '${channel_id}' could not be resolved`);
      }
      const result = await banter.delete(`/v1/channels/${resolved}/pins/${message_id}`);
      return result.ok
        ? { content: [{ type: 'text' as const, text: `Message ${message_id} unpinned.` }] }
        : writeErr('banter_unpin_message', 'unpinning message', result);
    },
  });

  // ---------------------------------------------------------------------------
  // Thread tools (2)
  // ---------------------------------------------------------------------------

  registerTool(server, {
    name: 'banter_list_thread_replies',
    description: 'List replies in a Banter message thread',
    input: {
      message_id: z.string().uuid().describe('The parent message ID'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(100).optional().describe('Number of replies to fetch'),
    },
    returns: z.object({ data: z.array(messageShape), next_cursor: z.string().nullable().optional() }),
    handler: async ({ message_id, ...params }) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const q = qs.toString();
      const result = await banter.get(`/v1/messages/${message_id}/thread${q ? `?${q}` : ''}`);
      return result.ok ? ok(result.data) : err('listing thread replies', result.data);
    },
  });

  registerTool(server, {
    name: 'banter_reply_to_thread',
    description: 'Post a reply in a Banter message thread',
    input: {
      message_id: z.string().uuid().describe('The parent message ID'),
      content: z.string().min(1).describe('Reply content (markdown supported)'),
      also_send_to_channel: z.boolean().optional().describe('Also post the reply to the main channel timeline'),
    },
    returns: messageShape,
    handler: async ({ message_id, ...body }) => {
      const result = await banter.post(`/v1/messages/${message_id}/thread`, body);
      return result.ok ? ok(result.data) : writeErr('banter_reply_to_thread', 'replying to thread', result);
    },
  });

  // ---------------------------------------------------------------------------
  // Search tools (3)
  // ---------------------------------------------------------------------------

  registerTool(server, {
    name: 'banter_search_messages',
    description: 'Search messages across Banter channels',
    input: {
      q: z.string().min(1).describe('Search query string'),
      channel_id: z.string().uuid().optional().describe('Limit search to a specific channel'),
      from_user_id: z.string().uuid().optional().describe('Filter by message author'),
      before: z.string().optional().describe('Search messages before this date (ISO 8601)'),
      after: z.string().optional().describe('Search messages after this date (ISO 8601)'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(50).optional().describe('Number of results'),
    },
    returns: z.object({ data: z.array(messageShape), total: z.number().optional(), next_cursor: z.string().nullable().optional() }),
    handler: async (params) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const result = await banter.get(`/v1/search/messages?${qs.toString()}`);
      return result.ok ? ok(result.data) : err('searching messages', result.data);
    },
  });

  registerTool(server, {
    name: 'banter_browse_channels',
    description: 'Browse available Banter channels (including unjoined public channels)',
    input: {
      q: z.string().optional().describe('Search query to filter channels'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(100).optional().describe('Number of results'),
    },
    returns: z.object({ data: z.array(channelShape), next_cursor: z.string().nullable().optional() }),
    handler: async (params) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const q = qs.toString();
      const result = await banter.get(`/v1/channels/browse${q ? `?${q}` : ''}`);
      return result.ok ? ok(result.data) : err('browsing channels', result.data);
    },
  });

  registerTool(server, {
    name: 'banter_search_transcripts',
    description: 'Search call transcripts across Banter (placeholder - returns available transcripts)',
    input: {
      q: z.string().min(1).describe('Search query string'),
      channel_id: z.string().uuid().optional().describe('Limit search to a specific channel'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(50).optional().describe('Number of results'),
    },
    returns: z.object({ data: z.array(z.object({ call_id: z.string().uuid(), excerpt: z.string().optional() }).passthrough()), next_cursor: z.string().nullable().optional() }),
    handler: async (params) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const result = await banter.get(`/v1/search/transcripts?${qs.toString()}`);
      return result.ok ? ok(result.data) : err('searching transcripts', result.data);
    },
  });

  // ---------------------------------------------------------------------------
  // DM tools (2)
  // ---------------------------------------------------------------------------

  registerTool(server, {
    name: 'banter_send_dm',
    description: 'Send a direct message to another user (creates or reuses existing DM channel). Accepts a user UUID, email address, or @handle.',
    input: {
      to_user_id: z
        .string()
        .min(1)
        .describe('Recipient as UUID, email address, or @handle'),
      content: z.string().min(1).describe('Message content'),
    },
    returns: messageShape,
    handler: async ({ to_user_id, content }) => {
      const resolvedUser = await resolveUserId(banter, to_user_id);
      if (!resolvedUser) {
        return err('User not found', `User '${to_user_id}' could not be resolved`);
      }

      // Step 1: Create or get existing DM channel
      const dmResult = await banter.post('/v1/dm', { user_id: resolvedUser });
      if (!dmResult.ok) return writeErr('banter_send_dm', 'creating DM channel', dmResult);

      const channelId = (dmResult.data as Record<string, unknown>).id ??
        ((dmResult.data as Record<string, unknown>).data as Record<string, unknown>)?.id;

      if (!channelId) return err('creating DM channel', { error: 'No channel ID returned' });

      // Step 2: Post message in the DM channel
      const msgResult = await banter.post(`/v1/channels/${channelId}/messages`, { content });
      return msgResult.ok ? ok(msgResult.data) : writeErr('banter_send_dm', 'sending DM', msgResult);
    },
  });

  registerTool(server, {
    name: 'banter_send_group_dm',
    description: 'Send a group direct message (creates or reuses existing group DM). Each recipient may be a UUID, email, or @handle — mixed lists are supported.',
    input: {
      user_ids: z
        .array(z.string().min(1))
        .min(2)
        .max(7)
        .describe('Recipients (2-7). Each element may be a UUID, email address, or @handle.'),
      content: z.string().min(1).describe('Message content'),
    },
    returns: messageShape,
    handler: async ({ user_ids, content }) => {
      const resolvedUsers = await Promise.all(
        user_ids.map((id) => resolveUserId(banter, id)),
      );
      const failed = user_ids.filter((_, i) => !resolvedUsers[i]);
      if (failed.length > 0) {
        return err('Users not found', `Could not resolve: ${failed.join(', ')}`);
      }
      const userIds = resolvedUsers.filter((id): id is string => id !== null);

      // Step 1: Create or get existing group DM channel
      const dmResult = await banter.post('/v1/group-dm', { user_ids: userIds });
      if (!dmResult.ok) return writeErr('banter_send_group_dm', 'creating group DM', dmResult);

      const channelId = (dmResult.data as Record<string, unknown>).id ??
        ((dmResult.data as Record<string, unknown>).data as Record<string, unknown>)?.id;

      if (!channelId) return err('creating group DM', { error: 'No channel ID returned' });

      // Step 2: Post message in the group DM channel
      const msgResult = await banter.post(`/v1/channels/${channelId}/messages`, { content });
      return msgResult.ok ? ok(msgResult.data) : writeErr('banter_send_group_dm', 'sending group DM', msgResult);
    },
  });

  // ---------------------------------------------------------------------------
  // User resolver tools (3) — read-only lookups for translating a human
  // identifier (email, handle, fuzzy name) into a stable user id. Banter
  // does not own its user table; these resolve against the shared Bam
  // users table and are scoped to the caller's active org.
  // ---------------------------------------------------------------------------

  registerTool(server, {
    name: 'banter_find_user_by_email',
    description: 'Find a Banter user by email (case-insensitive exact match). Returns {id, email, name, display_name, avatar_url} or null if no match.',
    input: {
      email: z.string().min(1).describe('The email address to look up.'),
    },
    returns: z.object({ data: banterUserShape.nullable() }).passthrough(),
    handler: async ({ email }) => {
      const qs = new URLSearchParams({ email });
      const result = await banter.get(`/v1/users/by-email?${qs.toString()}`);
      return result.ok ? ok(result.data) : err('finding user by email', result.data);
    },
  });

  registerTool(server, {
    name: 'banter_find_user_by_handle',
    description: 'Find a Banter user by handle (accepts "@alice" or "alice"). Banter users do not have a dedicated handle column — matching falls back to a slugified form of display_name (lower-cased, whitespace collapsed to hyphens). Returns the user or null.',
    input: {
      handle: z.string().min(1).describe('The user handle. A leading "@" is accepted and stripped.'),
    },
    returns: z.object({ data: banterUserShape.nullable() }).passthrough(),
    handler: async ({ handle }) => {
      const cleaned = handle.replace(/^@/, '').trim();
      if (!cleaned) return ok({ data: null });
      const result = await banter.get(
        `/v1/users/by-handle/${encodeURIComponent(cleaned)}`,
      );
      return result.ok ? ok(result.data) : err('finding user by handle', result.data);
    },
  });

  registerTool(server, {
    name: 'banter_list_users',
    description: 'Fuzzy search Banter users by name, display name, or email. Returns up to 20 users in the active org ordered by relevance. If no query is supplied, returns the 20 most recently created users.',
    input: {
      query: z
        .string()
        .optional()
        .describe('Optional fuzzy search term matched against display_name and email.'),
    },
    returns: z.object({ data: z.array(banterUserShape) }).passthrough(),
    handler: async ({ query }) => {
      const qs = new URLSearchParams();
      if (query !== undefined && query.trim().length > 0) qs.set('q', query);
      qs.set('limit', '20');
      const result = await banter.get(`/v1/users/search?${qs.toString()}`);
      return result.ok ? ok(result.data) : err('listing users', result.data);
    },
  });

  // ---------------------------------------------------------------------------
  // User group tools (5)
  // ---------------------------------------------------------------------------

  registerTool(server, {
    name: 'banter_list_user_groups',
    description: 'List all user groups in the organization',
    input: {
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(100).optional().describe('Number of results'),
    },
    returns: z.object({ data: z.array(userGroupShape), next_cursor: z.string().nullable().optional() }),
    handler: async (params) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const q = qs.toString();
      const result = await banter.get(`/v1/user-groups${q ? `?${q}` : ''}`);
      return result.ok ? ok(result.data) : err('listing user groups', result.data);
    },
  });

  // Resolver: closes the loop on banter_create_user_group, which takes a
  // handle. This lets callers check for an existing group or follow up a
  // creation with a stable id lookup without needing to scan the list.
  registerTool(server, {
    name: 'banter_get_user_group_by_handle',
    description: 'Resolve a Banter user group by handle (accepts "@engineering" or "engineering"). Returns {id, name, handle, description, member_count} or null if no match.',
    input: {
      handle: z.string().min(1).describe('The group handle. A leading "@" is accepted and stripped.'),
    },
    returns: z.object({
      data: userGroupShape.extend({ member_count: z.number().optional() }).nullable(),
    }).passthrough(),
    handler: async ({ handle }) => {
      const cleaned = handle.replace(/^@/, '').trim();
      if (!cleaned) return ok({ data: null });
      const result = await banter.get(
        `/v1/user-groups/by-handle/${encodeURIComponent(cleaned)}`,
      );
      return result.ok ? ok(result.data) : err('resolving user group by handle', result.data);
    },
  });

  registerTool(server, {
    name: 'banter_create_user_group',
    description: 'Create a new user group (e.g. @backend-team)',
    input: {
      name: z.string().min(1).max(80).describe('Group name'),
      handle: z.string().min(1).max(40).describe('Group handle for @mentions (lowercase, no spaces)'),
      description: z.string().optional().describe('Group description'),
      user_ids: z.array(z.string().uuid()).optional().describe('Initial member user IDs'),
    },
    returns: userGroupShape,
    handler: async (params) => {
      const result = await banter.post('/v1/user-groups', params);
      return result.ok ? ok(result.data) : writeErr('banter_create_user_group', 'creating user group', result);
    },
  });

  registerTool(server, {
    name: 'banter_update_user_group',
    description: 'Update a user group name, handle, or description',
    input: {
      group_id: z.string().uuid().describe('The user group ID'),
      name: z.string().min(1).max(80).optional().describe('New group name'),
      handle: z.string().min(1).max(40).optional().describe('New group handle'),
      description: z.string().optional().describe('New description'),
    },
    returns: userGroupShape,
    handler: async ({ group_id, ...updates }) => {
      const result = await banter.patch(`/v1/user-groups/${group_id}`, updates);
      return result.ok ? ok(result.data) : writeErr('banter_update_user_group', 'updating user group', result);
    },
  });

  registerTool(server, {
    name: 'banter_add_group_members',
    description: 'Add members to a user group',
    input: {
      group_id: z.string().uuid().describe('The user group ID'),
      user_ids: z.array(z.string().uuid()).min(1).describe('User IDs to add'),
    },
    returns: z.object({ added: z.number(), members: z.array(z.string().uuid()).optional() }).passthrough(),
    handler: async ({ group_id, user_ids }) => {
      const result = await banter.post(`/v1/user-groups/${group_id}/members`, { user_ids });
      return result.ok ? ok(result.data) : writeErr('banter_add_group_members', 'adding group members', result);
    },
  });

  registerTool(server, {
    name: 'banter_remove_group_member',
    description: 'Remove a member from a user group',
    input: {
      group_id: z.string().uuid().describe('The user group ID'),
      user_id: z.string().uuid().describe('The user ID to remove'),
    },
    returns: z.object({ ok: z.boolean() }),
    handler: async ({ group_id, user_id }) => {
      const result = await banter.delete(`/v1/user-groups/${group_id}/members/${user_id}`);
      return result.ok
        ? { content: [{ type: 'text' as const, text: `User ${user_id} removed from group ${group_id}.` }] }
        : writeErr('banter_remove_group_member', 'removing group member', result);
    },
  });

  // ---------------------------------------------------------------------------
  // Call tools (10)
  // ---------------------------------------------------------------------------

  registerTool(server, {
    name: 'banter_start_call',
    description: 'Start a new voice/video call in a Banter channel. Accepts a channel UUID, name, or #name.',
    input: {
      channel_id: z
        .string()
        .min(1)
        .describe('Channel UUID, name, or #name'),
      type: z.enum(['voice', 'video', 'huddle']).optional().describe('Call type (default: voice)'),
    },
    returns: callShape,
    handler: async ({ channel_id, ...body }) => {
      const resolved = await resolveChannelId(banter, channel_id);
      if (!resolved) {
        return err('Channel not found', `Channel '${channel_id}' could not be resolved`);
      }
      const result = await banter.post(`/v1/channels/${resolved}/calls`, body);
      return result.ok ? ok(result.data) : writeErr('banter_start_call', 'starting call', result);
    },
  });

  registerTool(server, {
    name: 'banter_join_call',
    description: 'Join an active call',
    input: {
      call_id: z.string().uuid().describe('The call ID'),
    },
    returns: z.object({ call_id: z.string().uuid(), join_token: z.string().optional() }).passthrough(),
    handler: async ({ call_id }) => {
      const result = await banter.post(`/v1/calls/${call_id}/join`);
      return result.ok ? ok(result.data) : writeErr('banter_join_call', 'joining call', result);
    },
  });

  registerTool(server, {
    name: 'banter_leave_call',
    description: 'Leave an active call',
    input: {
      call_id: z.string().uuid().describe('The call ID'),
    },
    returns: z.object({ ok: z.boolean() }),
    handler: async ({ call_id }) => {
      const result = await banter.post(`/v1/calls/${call_id}/leave`);
      return result.ok ? ok(result.data) : writeErr('banter_leave_call', 'leaving call', result);
    },
  });

  registerTool(server, {
    name: 'banter_end_call',
    description: 'End an active call (destructive - requires confirmation)',
    input: {
      call_id: z.string().uuid().describe('The call ID'),
      confirm: z.boolean().describe('Must be true to confirm ending the call'),
    },
    returns: z.object({ ok: z.boolean() }),
    handler: async ({ call_id, confirm }) => {
      if (!confirm) {
        return {
          content: [{
            type: 'text' as const,
            text: `Are you sure you want to end call ${call_id}? Call this tool again with confirm: true to proceed.`,
          }],
        };
      }
      const result = await banter.post(`/v1/calls/${call_id}/end`);
      return result.ok
        ? { content: [{ type: 'text' as const, text: `Call ${call_id} ended.` }] }
        : writeErr('banter_end_call', 'ending call', result);
    },
  });

  registerTool(server, {
    name: 'banter_get_call',
    description: 'Get details about a specific call',
    input: {
      call_id: z.string().uuid().describe('The call ID'),
    },
    returns: callShape,
    handler: async ({ call_id }) => {
      const result = await banter.get(`/v1/calls/${call_id}`);
      return result.ok ? ok(result.data) : err('getting call', result.data);
    },
  });

  registerTool(server, {
    name: 'banter_list_calls',
    description: 'List calls in a Banter channel (active and recent)',
    input: {
      channel_id: z.string().uuid().describe('The channel ID'),
      status: z.enum(['active', 'ended', 'all']).optional().describe('Filter by call status'),
      cursor: z.string().optional().describe('Pagination cursor'),
      limit: z.number().int().positive().max(50).optional().describe('Number of results'),
    },
    returns: z.object({ data: z.array(callShape), next_cursor: z.string().nullable().optional() }),
    handler: async ({ channel_id, ...params }) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const q = qs.toString();
      const result = await banter.get(`/v1/channels/${channel_id}/calls${q ? `?${q}` : ''}`);
      return result.ok ? ok(result.data) : err('listing calls', result.data);
    },
  });

  registerTool(server, {
    name: 'banter_get_transcript',
    description: 'Get the transcript for a call',
    input: {
      call_id: z.string().uuid().describe('The call ID'),
    },
    returns: z.object({ call_id: z.string().uuid(), segments: z.array(z.object({ speaker: z.string().optional(), text: z.string(), timestamp: z.string().optional() }).passthrough()).optional() }).passthrough(),
    handler: async ({ call_id }) => {
      const result = await banter.get(`/v1/calls/${call_id}/transcript`);
      return result.ok ? ok(result.data) : err('getting transcript', result.data);
    },
  });

  registerTool(server, {
    name: 'banter_invite_agent_to_call',
    description: 'Invite an AI agent to join an active call as a participant',
    input: {
      call_id: z.string().uuid().describe('The call ID'),
      agent_id: z.string().uuid().optional().describe('Specific agent ID to invite (uses default if omitted)'),
    },
    returns: z.object({ call_id: z.string().uuid(), agent_id: z.string().uuid().optional() }).passthrough(),
    handler: async ({ call_id, ...body }) => {
      const result = await banter.post(`/v1/calls/${call_id}/invite-agent`, body);
      return result.ok ? ok(result.data) : writeErr('banter_invite_agent_to_call', 'inviting agent to call', result);
    },
  });

  registerTool(server, {
    name: 'banter_post_call_text',
    description: 'Post a text message in a call channel with a call reference (for text-mode AI participation)',
    input: {
      channel_id: z.string().uuid().describe('The channel ID where the call is happening'),
      call_id: z.string().uuid().describe('The active call ID to reference'),
      content: z.string().min(1).describe('Message content'),
    },
    returns: messageShape,
    handler: async ({ channel_id, call_id, content }) => {
      const result = await banter.post(`/v1/channels/${channel_id}/messages`, {
        content,
        metadata: { call_id },
      });
      return result.ok ? ok(result.data) : writeErr('banter_post_call_text', 'posting call text', result);
    },
  });

  registerTool(server, {
    name: 'banter_get_active_huddle',
    description: 'Check if a channel has an active huddle and get its details',
    input: {
      channel_id: z.string().uuid().describe('The channel ID'),
    },
    returns: callShape.or(z.object({ message: z.string() })),
    handler: async ({ channel_id }) => {
      const result = await banter.get(`/v1/channels/${channel_id}`);
      if (!result.ok) return err('getting channel for huddle check', result.data);

      const data = result.data as Record<string, unknown>;
      const huddleId = data.active_huddle_id ?? (data.data as Record<string, unknown>)?.active_huddle_id;

      if (!huddleId) {
        return { content: [{ type: 'text' as const, text: 'No active huddle in this channel.' }] };
      }

      // Fetch huddle/call details
      const callResult = await banter.get(`/v1/calls/${huddleId}`);
      return callResult.ok ? ok(callResult.data) : ok({ active_huddle_id: huddleId, detail: 'Could not fetch huddle details' });
    },
  });

  // ---------------------------------------------------------------------------
  // Integration tools (4)
  // ---------------------------------------------------------------------------

  registerTool(server, {
    name: 'banter_share_task',
    description: 'Share a BigBlueBam task as a rich embed in a Banter channel. Accepts a channel UUID, name, or #name.',
    input: {
      channel_id: z
        .string()
        .min(1)
        .describe('Channel UUID, name, or #name to post in'),
      task_id: z.string().uuid().describe('The Bam task ID to share'),
      comment: z.string().optional().describe('Optional comment to include with the share'),
    },
    returns: messageShape,
    handler: async ({ channel_id, task_id, comment }) => {
      const resolved = await resolveChannelId(banter, channel_id);
      if (!resolved) {
        return err('Channel not found', `Channel '${channel_id}' could not be resolved`);
      }
      const content = comment ? `${comment}\n\n[task:${task_id}]` : `[task:${task_id}]`;
      const result = await banter.post(`/v1/channels/${resolved}/messages`, {
        content,
        embeds: [{ type: 'bbb_task', id: task_id }],
      });
      return result.ok ? ok(result.data) : writeErr('banter_share_task', 'sharing task', result);
    },
  });

  registerTool(server, {
    name: 'banter_share_sprint',
    description: 'Share a BigBlueBam sprint summary as a rich embed in a Banter channel. Accepts a channel UUID, name, or #name.',
    input: {
      channel_id: z
        .string()
        .min(1)
        .describe('Channel UUID, name, or #name to post in'),
      sprint_id: z.string().uuid().describe('The Bam sprint ID to share'),
      comment: z.string().optional().describe('Optional comment to include'),
    },
    returns: messageShape,
    handler: async ({ channel_id, sprint_id, comment }) => {
      const resolved = await resolveChannelId(banter, channel_id);
      if (!resolved) {
        return err('Channel not found', `Channel '${channel_id}' could not be resolved`);
      }
      const content = comment ? `${comment}\n\n[sprint:${sprint_id}]` : `[sprint:${sprint_id}]`;
      const result = await banter.post(`/v1/channels/${resolved}/messages`, {
        content,
        embeds: [{ type: 'bbb_sprint', id: sprint_id }],
      });
      return result.ok ? ok(result.data) : writeErr('banter_share_sprint', 'sharing sprint', result);
    },
  });

  registerTool(server, {
    name: 'banter_share_ticket',
    description: 'Share a Helpdesk ticket as a rich embed in a Banter channel. Accepts a channel UUID, name, or #name.',
    input: {
      channel_id: z
        .string()
        .min(1)
        .describe('Channel UUID, name, or #name to post in'),
      ticket_id: z.string().uuid().describe('The Helpdesk ticket ID to share'),
      comment: z.string().optional().describe('Optional comment to include'),
    },
    returns: messageShape,
    handler: async ({ channel_id, ticket_id, comment }) => {
      const resolved = await resolveChannelId(banter, channel_id);
      if (!resolved) {
        return err('Channel not found', `Channel '${channel_id}' could not be resolved`);
      }
      const content = comment ? `${comment}\n\n[ticket:${ticket_id}]` : `[ticket:${ticket_id}]`;
      const result = await banter.post(`/v1/channels/${resolved}/messages`, {
        content,
        embeds: [{ type: 'helpdesk_ticket', id: ticket_id }],
      });
      return result.ok ? ok(result.data) : writeErr('banter_share_ticket', 'sharing ticket', result);
    },
  });

  registerTool(server, {
    name: 'banter_get_unread',
    description: 'Get the current user\'s unread message summary across all Banter channels',
    input: {},
    returns: z.object({}).passthrough(),
    handler: async () => {
      const result = await banter.get('/v1/me/unread');
      return result.ok ? ok(result.data) : err('getting unread', result.data);
    },
  });

  // ---------------------------------------------------------------------------
  // Preferences & Presence (3)
  // ---------------------------------------------------------------------------

  registerTool(server, {
    name: 'banter_get_preferences',
    description: 'Get the authenticated user\'s Banter notification and theme preferences.',
    input: {},
    returns: z.object({}).passthrough(),
    handler: async () => {
      const result = await banter.get('/v1/me/preferences');
      return result.ok ? ok(result.data) : err('getting preferences', result.data);
    },
  });

  registerTool(server, {
    name: 'banter_update_preferences',
    description: 'Update the authenticated user\'s Banter notification and theme preferences.',
    input: {
      preferences: z.record(z.unknown()).describe('Preference keys to update (notification settings, theme, etc.).'),
    },
    returns: z.object({}).passthrough(),
    handler: async ({ preferences }) => {
      const result = await banter.patch('/v1/me/preferences', preferences);
      return result.ok ? ok(result.data) : writeErr('banter_update_preferences', 'updating preferences', result);
    },
  });

  registerTool(server, {
    name: 'banter_set_presence',
    description: 'Set the authenticated user\'s presence status in Banter. The status is ephemeral — it auto-expires via a Redis TTL, so callers should not treat it as persistent.',
    input: {
      status: z.enum(['online', 'idle', 'dnd', 'offline']).describe('Presence status.'),
      status_text: z.string().max(128).optional().describe('Custom status text.'),
      status_emoji: z.string().max(8).optional().describe('Status emoji.'),
    },
    returns: z.object({ status: z.string(), expires_at: z.string().optional() }).passthrough(),
    handler: async ({ status, status_text, status_emoji }) => {
      const result = await banter.post('/v1/me/presence', { status, status_text, status_emoji });
      return result.ok ? ok(result.data) : writeErr('banter_set_presence', 'setting presence', result);
    },
  });
}
