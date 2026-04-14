import { z } from 'zod';

// ── Enums ──────────────────────────────────────────────────────────────
export const BanterChannelType = z.enum(['public', 'private', 'dm', 'group_dm']);
export const BanterContentFormat = z.enum(['html', 'markdown', 'plain']);
export const BanterNotificationLevel = z.enum(['all', 'mentions', 'none']);
export const BanterSidebarSort = z.enum(['recent', 'alpha', 'custom']);
export const BanterTimestampVisibility = z.enum(['hover', 'always', 'never']);
export const BanterPresenceStatus = z.enum(['online', 'idle', 'dnd']);
export const BanterCallType = z.enum(['voice', 'video', 'huddle']);
export const BanterAiAgentMode = z.enum(['auto', 'on', 'off']);
export const BanterChannelCreationPolicy = z.enum(['members', 'admins']);

// ── Channel schemas ────────────────────────────────────────────────────
export const createBanterChannelSchema = z.object({
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

export const updateBanterChannelSchema = z.object({
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

export const addBanterChannelMembersSchema = z.object({
  user_ids: z.array(z.string().uuid()).min(1).max(100),
});

export const markBanterChannelReadSchema = z.object({
  message_id: z.string().uuid(),
});

// ── Message schemas ────────────────────────────────────────────────────
export const createBanterMessageSchema = z.object({
  content: z.string().min(1).max(40000),
  content_format: BanterContentFormat.default('html'),
  thread_parent_id: z.string().uuid().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const updateBanterMessageSchema = z.object({
  content: z.string().min(1).max(40000),
});

export const listBanterMessagesQuerySchema = z.object({
  before: z.string().optional(),
  after: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

// ── Thread schemas ─────────────────────────────────────────────────────
export const createBanterThreadReplySchema = z.object({
  content: z.string().min(1).max(40000),
  content_format: BanterContentFormat.default('html'),
});

// ── DM schemas ─────────────────────────────────────────────────────────
export const createBanterDmSchema = z.object({
  user_id: z.string().uuid(),
});

export const createBanterGroupDmSchema = z.object({
  user_ids: z.array(z.string().uuid()).min(2).max(7),
});

// ── Reaction schemas ───────────────────────────────────────────────────
export const toggleBanterReactionSchema = z.object({
  emoji: z.string().min(1).max(50),
});

// ── Bookmark schemas ───────────────────────────────────────────────────
export const createBanterBookmarkSchema = z.object({
  message_id: z.string().uuid(),
  note: z.string().max(500).optional(),
});

// ── Pin schemas ────────────────────────────────────────────────────────
export const createBanterPinSchema = z.object({
  message_id: z.string().uuid(),
});

// ── Preference schemas ─────────────────────────────────────────────────
export const updateBanterPreferencesSchema = z.object({
  default_notification_level: BanterNotificationLevel.optional(),
  sidebar_sort: BanterSidebarSort.optional(),
  sidebar_collapsed_groups: z.array(z.string().uuid()).optional(),
  theme_override: z.string().max(20).nullable().optional(),
  enter_sends_message: z.boolean().optional(),
  show_message_timestamps: BanterTimestampVisibility.optional(),
  compact_mode: z.boolean().optional(),
  auto_join_huddles: z.boolean().optional(),
  noise_suppression: z.boolean().optional(),
});

export const setBanterPresenceSchema = z.object({
  status: BanterPresenceStatus,
});

// ── Call schemas ───────────────────────────────────────────────────────
export const startBanterCallSchema = z.object({
  type: BanterCallType,
  title: z.string().max(255).optional(),
  ai_agent_mode: BanterAiAgentMode.default('auto'),
});

export const listBanterCallHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// ── User group schemas ─────────────────────────────────────────────────
export const createBanterUserGroupSchema = z.object({
  name: z.string().min(1).max(80),
  handle: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Must be lowercase alphanumeric with hyphens'),
  description: z.string().max(500).optional(),
});

export const updateBanterUserGroupSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  handle: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'Must be lowercase alphanumeric with hyphens')
    .optional(),
  description: z.string().max(500).nullable().optional(),
});

export const addBanterUserGroupMembersSchema = z.object({
  user_ids: z.array(z.string().uuid()).min(1).max(100),
});

// ── Channel group / admin schemas ──────────────────────────────────────
export const createBanterChannelGroupSchema = z.object({
  name: z.string().min(1).max(100),
  position: z.number().int().min(0).optional(),
  is_collapsed_default: z.boolean().optional(),
});

export const updateBanterChannelGroupSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  position: z.number().int().min(0).optional(),
  is_collapsed_default: z.boolean().optional(),
});

export const reorderBanterChannelGroupsSchema = z.object({
  order: z.array(
    z.object({
      id: z.string().uuid(),
      position: z.number().int().min(0),
    }),
  ),
});

export const updateBanterSettingsSchema = z.object({
  allow_channel_creation: BanterChannelCreationPolicy.optional(),
  allow_dm: z.boolean().optional(),
  allow_group_dm: z.boolean().optional(),
  allow_guest_access: z.boolean().optional(),
  message_retention_days: z.number().int().min(0).optional(),
  max_file_size_mb: z.number().int().min(1).optional(),
  allowed_file_types: z.array(z.string()).optional(),
  enable_link_previews: z.boolean().optional(),
  enable_bbb_integration: z.boolean().optional(),
  voice_video_enabled: z.boolean().optional(),
  livekit_host: z.string().max(500).nullable().optional(),
  livekit_api_key: z.string().max(255).nullable().optional(),
  livekit_api_secret: z.string().nullable().optional(),
  max_call_participants: z.number().int().min(2).max(500).optional(),
  max_call_duration_minutes: z.number().int().min(1).optional(),
});

// ── Search schemas ─────────────────────────────────────────────────────
export const searchBanterMessagesQuerySchema = z.object({
  q: z.string().min(1).max(500),
  channel_id: z.string().uuid().optional(),
  author_id: z.string().uuid().optional(),
  before: z.string().datetime().optional(),
  after: z.string().datetime().optional(),
  has_attachments: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const searchBanterTranscriptsQuerySchema = z.object({
  q: z.string().min(1).max(500),
  channel_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export const searchBanterChannelsQuerySchema = z.object({
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

// ── User resolver schemas ──────────────────────────────────────────────
export const listBanterUsersQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(20),
});
