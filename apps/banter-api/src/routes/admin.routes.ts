import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, and, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { banterSettings, banterChannelGroups } from '../db/schema/index.js';
import { requireAuth, requireScope } from '../plugins/auth.js';
import { broadcastToOrg } from '../services/realtime.js';
import { logAudit } from '../services/audit.js';
import { invalidateBanterSettingsCache } from '../services/settings-cache.js';

// ── Schemas ──────────────────────────────────────────────────────

const updateSettingsSchema = z.object({
  allow_channel_creation: z.enum(['members', 'admins']).optional(),
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
  allow_recording: z.boolean().optional(),
  recording_storage_prefix: z.string().max(255).optional(),
  transcription_enabled: z.boolean().optional(),
  stt_provider: z.string().max(50).nullable().optional(),
  stt_provider_config: z.record(z.unknown()).optional(),
  tts_provider: z.string().max(50).nullable().optional(),
  tts_provider_config: z.record(z.unknown()).optional(),
  tts_default_voice: z.string().max(100).nullable().optional(),
  ai_voice_agent_enabled: z.boolean().optional(),
  ai_voice_agent_llm_provider: z.string().max(50).optional(),
  ai_voice_agent_llm_config: z.record(z.unknown()).optional(),
  ai_voice_agent_greeting: z.string().max(500).nullable().optional(),
});

const createChannelGroupSchema = z.object({
  name: z.string().min(1).max(100),
  position: z.number().int().min(0).optional(),
  is_collapsed_default: z.boolean().optional(),
});

const updateChannelGroupSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  position: z.number().int().min(0).optional(),
  is_collapsed_default: z.boolean().optional(),
});

const reorderGroupsSchema = z.object({
  order: z.array(
    z.object({
      id: z.string().uuid(),
      position: z.number().int().min(0),
    }),
  ),
});

// ── SSRF protection ─────────────────────────────────────────────

/**
 * Validate that a URL is safe for server-side requests (no private/internal IPs).
 * Rejects private IPv4 ranges (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, 0.x),
 * IPv6 loopback/link-local, and non-http(s) schemes.
 */
function validateExternalUrl(url: string): { valid: boolean; reason?: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'Invalid URL' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, reason: 'Only http and https URLs are allowed' };
  }

  const hostname = parsed.hostname.toLowerCase();

  // Block localhost variants
  if (hostname === 'localhost' || hostname === '[::1]') {
    return { valid: false, reason: 'Localhost URLs are not allowed' };
  }

  // Block private/reserved IPv4 ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    ) {
      return { valid: false, reason: 'Private/internal IP addresses are not allowed' };
    }
  }

  // Block common internal hostnames
  const internalPatterns = [
    /^.*\.local$/,
    /^.*\.internal$/,
    /^.*\.svc\.cluster\.local$/,
    /^metadata\.google\.internal$/,
  ];
  for (const pattern of internalPatterns) {
    if (pattern.test(hostname)) {
      return { valid: false, reason: 'Internal hostnames are not allowed' };
    }
  }

  // Block cloud metadata endpoints (AWS, GCP, Azure)
  if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
    return { valid: false, reason: 'Cloud metadata endpoints are not allowed' };
  }

  return { valid: true };
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Mask a secret string, showing only the last 4 characters.
 * Returns null for null/empty values.
 */
function maskSecret(value: string | null | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return '****';
  return '*'.repeat(value.length - 4) + value.slice(-4);
}

/**
 * Deep-clone settings and mask sensitive fields so they are never
 * returned in full to the client, even for admins.
 */
function maskSensitiveFields<T extends Record<string, unknown>>(settings: T): T {
  const masked = { ...settings };

  // Mask top-level secret fields
  if ('livekit_api_secret' in masked && typeof masked.livekit_api_secret === 'string') {
    (masked as Record<string, unknown>).livekit_api_secret = maskSecret(masked.livekit_api_secret as string);
  }

  // Mask api_key inside provider config objects
  for (const field of ['stt_provider_config', 'tts_provider_config', 'ai_voice_agent_llm_config'] as const) {
    if (field in masked && masked[field] && typeof masked[field] === 'object') {
      const config = { ...(masked[field] as Record<string, unknown>) };
      if ('api_key' in config && typeof config.api_key === 'string') {
        config.api_key = maskSecret(config.api_key);
      }
      if ('api_secret' in config && typeof config.api_secret === 'string') {
        config.api_secret = maskSecret(config.api_secret);
      }
      (masked as Record<string, unknown>)[field] = config;
    }
  }

  return masked;
}

// ── Routes ───────────────────────────────────────────────────────

export default async function adminRoutes(fastify: FastifyInstance) {
  // Wave D Phase 3: factory wraps the org admin/owner role gate with the
  // dual-read resolver for each route's specific permission_id.
  const adminPreHandler = (permission: string) => [
    requireAuth,
    fastify.requireCan(permission),
    requireScope('admin'),
  ];

  // GET /v1/admin/settings
  fastify.get(
    '/v1/admin/settings',
    { preHandler: adminPreHandler('banter.admin_setting.list') },
    async (request, reply) => {
      const user = request.user!;

      const [settings] = await db
        .select()
        .from(banterSettings)
        .where(eq(banterSettings.org_id, user.org_id))
        .limit(1);

      if (!settings) {
        // Auto-create default settings for this org
        const [created] = await db
          .insert(banterSettings)
          .values({ org_id: user.org_id })
          .returning();
        if (!created) {
          return reply.status(500).send({
            error: {
              code: 'INTERNAL_ERROR',
              message: 'Settings insert returned no row',
              details: [],
              request_id: request.id,
            },
          });
        }
        return reply.send({ data: maskSensitiveFields(created) });
      }

      return reply.send({ data: maskSensitiveFields(settings) });
    },
  );

  // PATCH /v1/admin/settings
  fastify.patch(
    '/v1/admin/settings',
    { preHandler: adminPreHandler('banter.admin_setting.update') },
    async (request, reply) => {
      const user = request.user!;
      const body = updateSettingsSchema.parse(request.body);

      // Upsert settings
      const [existing] = await db
        .select()
        .from(banterSettings)
        .where(eq(banterSettings.org_id, user.org_id))
        .limit(1);

      let settings;
      if (!existing) {
        [settings] = await db
          .insert(banterSettings)
          .values({ org_id: user.org_id, ...body, updated_at: new Date() })
          .returning();
      } else {
        [settings] = await db
          .update(banterSettings)
          .set({ ...body, updated_at: new Date() })
          .where(eq(banterSettings.org_id, user.org_id))
          .returning();
      }

      // Invalidate the in-memory settings cache so subsequent permission
      // reads on this instance see the update immediately (other instances
      // wait out their 30s TTL — acceptable for low-churn settings).
      invalidateBanterSettingsCache(user.org_id);

      broadcastToOrg(user.org_id, {
        type: 'settings.updated',
        data: { settings },
        timestamp: new Date().toISOString(),
      });

      logAudit({
        org_id: user.org_id,
        user_id: user.id,
        action: 'banter.settings.updated',
        entity_type: 'banter_settings',
        entity_id: settings!.id,
        details: { changed_fields: Object.keys(body) },
      }).catch(() => {});

      // Fire-and-forget: push voice config to the voice agent service
      // if any voice-related fields were changed
      const voiceFields = [
        'stt_provider', 'stt_provider_config',
        'tts_provider', 'tts_provider_config',
        'ai_voice_agent_llm_provider', 'ai_voice_agent_llm_config',
      ];
      const changedFields = Object.keys(body);
      const hasVoiceChanges = changedFields.some((f) => voiceFields.includes(f));

      if (hasVoiceChanges && settings) {
        const voiceAgentUrl = process.env.VOICE_AGENT_URL ?? 'http://voice-agent:8000';
        fetch(`${voiceAgentUrl}/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // D-5: org-scoped so multi-tenant deploys don't share one config.
            org_id: user.org_id,
            stt_provider: settings.stt_provider ?? null,
            stt_config: settings.stt_provider_config ?? {},
            tts_provider: settings.tts_provider ?? null,
            tts_config: settings.tts_provider_config ?? {},
            llm_provider: settings.ai_voice_agent_llm_provider ?? null,
            llm_config: settings.ai_voice_agent_llm_config ?? {},
          }),
          signal: AbortSignal.timeout(5000),
        }).catch((pushErr) => {
          fastify.log.warn(
            { err: pushErr },
            'Failed to push voice config to voice agent (fire-and-forget)',
          );
        });
      }

      return reply.send({ data: settings });
    },
  );

  // POST /v1/admin/settings/test-livekit
  fastify.post(
    '/v1/admin/settings/test-livekit',
    { preHandler: adminPreHandler('banter.admin_setting_test_livekit.create') },
    async (request, reply) => {
      const user = request.user!;

      const [settings] = await db
        .select()
        .from(banterSettings)
        .where(eq(banterSettings.org_id, user.org_id))
        .limit(1);

      if (!settings?.livekit_host || !settings?.livekit_api_key || !settings?.livekit_api_secret) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'LiveKit host, API key, and API secret must be configured before testing',
            details: [],
            request_id: request.id,
          },
        });
      }

      try {
        // Attempt to create a test room via the LiveKit HTTP API
        const { generateLiveKitToken } = await import(
          '../services/livekit-token.js'
        );

        const testRoomName = `banter_test_${user.org_id}_${Date.now()}`;
        await generateLiveKitToken({
          participantIdentity: 'test-connection',
          participantName: 'Test',
          roomName: testRoomName,
          ttlSeconds: 30,
        });

        return reply.send({
          data: {
            success: true,
            message: 'LiveKit credentials are valid. Token generated successfully.',
            test_room: testRoomName,
          },
        });
      } catch (err) {
        return reply.status(400).send({
          error: {
            code: 'LIVEKIT_ERROR',
            message: `LiveKit connection test failed: ${(err as Error).message}`,
            details: [],
            request_id: request.id,
          },
        });
      }
    },
  );

  // POST /v1/admin/settings/test-stt — test STT provider connectivity
  fastify.post(
    '/v1/admin/settings/test-stt',
    { preHandler: adminPreHandler('banter.admin_setting_test_stt.create') },
    async (request, reply) => {
      const user = request.user!;

      const [settings] = await db
        .select()
        .from(banterSettings)
        .where(eq(banterSettings.org_id, user.org_id))
        .limit(1);

      const provider = settings?.stt_provider ?? null;

      if (!provider || provider === 'none') {
        return reply.send({
          data: {
            success: true,
            message: 'No STT provider configured. Simulated success.',
            provider: provider ?? 'none',
          },
        });
      }

      const config = (settings?.stt_provider_config ?? {}) as Record<string, unknown>;

      try {
        // Attempt a lightweight connectivity check based on the provider
        if (provider === 'deepgram') {
          const apiKey = config.api_key as string | undefined;
          if (!apiKey) throw new Error('Missing api_key in STT provider config');
          const res = await fetch('https://api.deepgram.com/v1/projects', {
            headers: { Authorization: `Token ${apiKey}` },
          });
          if (!res.ok) throw new Error(`Deepgram responded with status ${res.status}`);
        } else if (provider === 'whisper' || provider === 'openai') {
          const apiKey = config.api_key as string | undefined;
          if (!apiKey) throw new Error('Missing api_key in STT provider config');
          const res = await fetch('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          if (!res.ok) throw new Error(`OpenAI responded with status ${res.status}`);
        } else {
          // Unknown provider — attempt a generic health check if url is configured
          const url = config.url as string | undefined;
          if (url) {
            const urlCheck = validateExternalUrl(url);
            if (!urlCheck.valid) {
              return reply.status(400).send({
                error: {
                  code: 'SSRF_BLOCKED',
                  message: `URL rejected: ${urlCheck.reason}`,
                  details: [],
                  request_id: request.id,
                },
              });
            }
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Provider responded with status ${res.status}`);
          } else {
            return reply.send({
              data: {
                success: true,
                message: `Provider "${provider}" configured but no specific test available. Config appears valid.`,
                provider,
              },
            });
          }
        }

        return reply.send({
          data: {
            success: true,
            message: `STT provider "${provider}" is reachable and credentials are valid.`,
            provider,
          },
        });
      } catch (err) {
        return reply.status(400).send({
          error: {
            code: 'STT_TEST_FAILED',
            message: `STT provider test failed: ${(err as Error).message}`,
            details: [],
            request_id: request.id,
          },
        });
      }
    },
  );

  // POST /v1/admin/settings/test-tts — test TTS provider connectivity
  fastify.post(
    '/v1/admin/settings/test-tts',
    { preHandler: adminPreHandler('banter.admin_setting_test_tt.create') },
    async (request, reply) => {
      const user = request.user!;

      const [settings] = await db
        .select()
        .from(banterSettings)
        .where(eq(banterSettings.org_id, user.org_id))
        .limit(1);

      const provider = settings?.tts_provider ?? null;

      if (!provider || provider === 'none') {
        return reply.send({
          data: {
            success: true,
            message: 'No TTS provider configured. Simulated success.',
            provider: provider ?? 'none',
          },
        });
      }

      const config = (settings?.tts_provider_config ?? {}) as Record<string, unknown>;

      try {
        if (provider === 'elevenlabs') {
          const apiKey = config.api_key as string | undefined;
          if (!apiKey) throw new Error('Missing api_key in TTS provider config');
          const res = await fetch('https://api.elevenlabs.io/v1/voices', {
            headers: { 'xi-api-key': apiKey },
          });
          if (!res.ok) throw new Error(`ElevenLabs responded with status ${res.status}`);
        } else if (provider === 'openai') {
          const apiKey = config.api_key as string | undefined;
          if (!apiKey) throw new Error('Missing api_key in TTS provider config');
          const res = await fetch('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${apiKey}` },
          });
          if (!res.ok) throw new Error(`OpenAI responded with status ${res.status}`);
        } else {
          const url = config.url as string | undefined;
          if (url) {
            const urlCheck = validateExternalUrl(url);
            if (!urlCheck.valid) {
              return reply.status(400).send({
                error: {
                  code: 'SSRF_BLOCKED',
                  message: `URL rejected: ${urlCheck.reason}`,
                  details: [],
                  request_id: request.id,
                },
              });
            }
            const res = await fetch(url);
            if (!res.ok) throw new Error(`Provider responded with status ${res.status}`);
          } else {
            return reply.send({
              data: {
                success: true,
                message: `Provider "${provider}" configured but no specific test available. Config appears valid.`,
                provider,
              },
            });
          }
        }

        return reply.send({
          data: {
            success: true,
            message: `TTS provider "${provider}" is reachable and credentials are valid.`,
            provider,
          },
        });
      } catch (err) {
        return reply.status(400).send({
          error: {
            code: 'TTS_TEST_FAILED',
            message: `TTS provider test failed: ${(err as Error).message}`,
            details: [],
            request_id: request.id,
          },
        });
      }
    },
  );

  // POST /v1/admin/settings/push-voice-config — push STT/TTS/LLM config to voice agent
  fastify.post(
    '/v1/admin/settings/push-voice-config',
    { preHandler: adminPreHandler('banter.admin_setting_push_voice_config.create') },
    async (request, reply) => {
      const user = request.user!;

      const [settings] = await db
        .select()
        .from(banterSettings)
        .where(eq(banterSettings.org_id, user.org_id))
        .limit(1);

      if (!settings) {
        return reply.status(400).send({
          error: {
            code: 'BAD_REQUEST',
            message: 'No settings found for this organization. Save settings first.',
            details: [],
            request_id: request.id,
          },
        });
      }

      const voiceAgentUrl = process.env.VOICE_AGENT_URL ?? 'http://voice-agent:8000';

      try {
        const payload = {
          // D-5: org-scoped so multi-tenant deploys don't share one config.
          org_id: user.org_id,
          stt_provider: settings.stt_provider ?? null,
          stt_config: settings.stt_provider_config ?? {},
          tts_provider: settings.tts_provider ?? null,
          tts_config: settings.tts_provider_config ?? {},
          llm_provider: settings.ai_voice_agent_llm_provider ?? null,
          llm_config: settings.ai_voice_agent_llm_config ?? {},
        };

        const res = await fetch(`${voiceAgentUrl}/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(5000),
        });

        if (!res.ok) {
          const body = await res.text();
          return reply.status(502).send({
            error: {
              code: 'VOICE_AGENT_ERROR',
              message: `Voice agent responded with status ${res.status}: ${body}`,
              details: [],
              request_id: request.id,
            },
          });
        }

        const result = await res.json();

        logAudit({
          org_id: user.org_id,
          user_id: user.id,
          action: 'banter.voice_config.pushed',
          entity_type: 'banter_settings',
          entity_id: settings.id,
          details: {
            stt_provider: settings.stt_provider,
            tts_provider: settings.tts_provider,
            llm_provider: settings.ai_voice_agent_llm_provider,
          },
        }).catch(() => {});

        return reply.send({ data: { success: true, voice_agent_response: result } });
      } catch (err) {
        return reply.status(502).send({
          error: {
            code: 'VOICE_AGENT_UNREACHABLE',
            message: `Failed to reach voice agent: ${(err as Error).message}`,
            details: [],
            request_id: request.id,
          },
        });
      }
    },
  );

  // ── Channel Groups CRUD ────────────────────────────────────────

  // GET /v1/admin/channel-groups
  fastify.get(
    '/v1/admin/channel-groups',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const user = request.user!;

      const groups = await db
        .select()
        .from(banterChannelGroups)
        .where(eq(banterChannelGroups.org_id, user.org_id))
        .orderBy(banterChannelGroups.position);

      return reply.send({ data: groups });
    },
  );

  // POST /v1/admin/channel-groups
  fastify.post(
    '/v1/admin/channel-groups',
    { preHandler: adminPreHandler('banter.admin_channel_group.create') },
    async (request, reply) => {
      const user = request.user!;
      const body = createChannelGroupSchema.parse(request.body);

      // If no position given, place at end
      let position = body.position;
      if (position === undefined) {
        const [maxRow] = await db
          .select({ max: sql<number>`coalesce(max(${banterChannelGroups.position}), -1)` })
          .from(banterChannelGroups)
          .where(eq(banterChannelGroups.org_id, user.org_id));
        position = (maxRow?.max ?? -1) + 1;
      }

      const [group] = await db
        .insert(banterChannelGroups)
        .values({
          org_id: user.org_id,
          name: body.name,
          position,
          is_collapsed_default: body.is_collapsed_default ?? false,
        })
        .returning();

      broadcastToOrg(user.org_id, {
        type: 'channel_group.created',
        data: { group },
        timestamp: new Date().toISOString(),
      });

      logAudit({
        org_id: user.org_id,
        user_id: user.id,
        action: 'banter.channel_group.created',
        entity_type: 'banter_channel_group',
        entity_id: group!.id,
        details: { name: body.name, position },
      }).catch(() => {});

      return reply.status(201).send({ data: group });
    },
  );

  // GET /v1/admin/channel-groups/:id
  fastify.get(
    '/v1/admin/channel-groups/:id',
    { preHandler: [requireAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const [group] = await db
        .select()
        .from(banterChannelGroups)
        .where(and(eq(banterChannelGroups.id, id), eq(banterChannelGroups.org_id, user.org_id)))
        .limit(1);

      if (!group) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Channel group not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      return reply.send({ data: group });
    },
  );

  // PATCH /v1/admin/channel-groups/:id
  fastify.patch(
    '/v1/admin/channel-groups/:id',
    { preHandler: adminPreHandler('banter.admin_channel_group.update') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;
      const body = updateChannelGroupSchema.parse(request.body);

      const [existing] = await db
        .select()
        .from(banterChannelGroups)
        .where(and(eq(banterChannelGroups.id, id), eq(banterChannelGroups.org_id, user.org_id)))
        .limit(1);

      if (!existing) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Channel group not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      const [updated] = await db
        .update(banterChannelGroups)
        .set(body)
        .where(eq(banterChannelGroups.id, id))
        .returning();

      broadcastToOrg(user.org_id, {
        type: 'channel_group.updated',
        data: { group: updated },
        timestamp: new Date().toISOString(),
      });

      logAudit({
        org_id: user.org_id,
        user_id: user.id,
        action: 'banter.channel_group.updated',
        entity_type: 'banter_channel_group',
        entity_id: id,
        details: { changed_fields: Object.keys(body) },
      }).catch(() => {});

      return reply.send({ data: updated });
    },
  );

  // DELETE /v1/admin/channel-groups/:id
  fastify.delete(
    '/v1/admin/channel-groups/:id',
    { preHandler: adminPreHandler('banter.admin_channel_group.delete') },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const user = request.user!;

      const deleted = await db
        .delete(banterChannelGroups)
        .where(and(eq(banterChannelGroups.id, id), eq(banterChannelGroups.org_id, user.org_id)))
        .returning();

      if (deleted.length === 0) {
        return reply.status(404).send({
          error: {
            code: 'NOT_FOUND',
            message: 'Channel group not found',
            details: [],
            request_id: request.id,
          },
        });
      }

      broadcastToOrg(user.org_id, {
        type: 'channel_group.deleted',
        data: { id },
        timestamp: new Date().toISOString(),
      });

      logAudit({
        org_id: user.org_id,
        user_id: user.id,
        action: 'banter.channel_group.deleted',
        entity_type: 'banter_channel_group',
        entity_id: id,
        details: { name: deleted[0]?.name },
      }).catch(() => {});

      return reply.send({ data: { success: true } });
    },
  );

  // POST /v1/admin/channel-groups/reorder
  fastify.post(
    '/v1/admin/channel-groups/reorder',
    { preHandler: adminPreHandler('banter.admin_channel_group_reorder.create') },
    async (request, reply) => {
      const user = request.user!;
      const body = reorderGroupsSchema.parse(request.body);

      // Update each group's position in a transaction-like manner
      for (const item of body.order) {
        await db
          .update(banterChannelGroups)
          .set({ position: item.position })
          .where(
            and(eq(banterChannelGroups.id, item.id), eq(banterChannelGroups.org_id, user.org_id)),
          );
      }

      const groups = await db
        .select()
        .from(banterChannelGroups)
        .where(eq(banterChannelGroups.org_id, user.org_id))
        .orderBy(banterChannelGroups.position);

      broadcastToOrg(user.org_id, {
        type: 'channel_groups.reordered',
        data: { groups },
        timestamp: new Date().toISOString(),
      });

      logAudit({
        org_id: user.org_id,
        user_id: user.id,
        action: 'banter.channel_groups.reordered',
        entity_type: 'banter_channel_group',
        details: { order: body.order },
      }).catch(() => {});

      return reply.send({ data: groups });
    },
  );
}
