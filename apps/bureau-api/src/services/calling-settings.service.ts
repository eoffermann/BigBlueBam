/**
 * Platform calling settings resolver (D-1 remainder).
 *
 * Reads the SuperUser-managed `calling.*` keys from Bam's system_settings
 * table (shared Postgres) with a short in-process cache, falling back to
 * env vars when a key is unset — the same precedence the Platform Calling
 * Settings page advertises ("settings override env").
 *
 *   calling.global_enabled    → kill switch; default ON when unset.
 *   calling.livekit_host      → overrides LIVEKIT_URL for client ws_url.
 *   calling.livekit_api_key   → overrides LIVEKIT_API_KEY for token mints.
 *   calling.livekit_api_secret→ overrides LIVEKIT_API_SECRET.
 *
 * Failure posture: a system_settings read error keeps the last cached
 * value if there is one, else falls back to env-with-calling-enabled.
 * Availability over enforcement — a DB blip must not kill every call;
 * the kill switch is for deliberate operator action, and operators can
 * scale the SFU to zero if they need a hard stop during a DB outage.
 *
 * The kill switch is also mirrored to the Redis key
 * `calling:global_enabled` ('1'/'0') on every refresh so services without
 * Postgres access (voice-agent) can honor it cheaply.
 */

import { sql } from 'drizzle-orm';
import type Redis from 'ioredis';
import { db } from '../db/index.js';
import { env } from '../env.js';

const CACHE_TTL_MS = 15_000;

export const CALLING_ENABLED_REDIS_KEY = 'calling:global_enabled';

export interface CallingConfig {
  enabled: boolean;
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
}

let cache: { value: CallingConfig; expiresAt: number } | null = null;

function envFallback(): CallingConfig {
  return {
    enabled: true,
    livekitUrl: env.LIVEKIT_URL,
    livekitApiKey: env.LIVEKIT_API_KEY,
    livekitApiSecret: env.LIVEKIT_API_SECRET,
  };
}

function nonEmptyString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Resolve the effective calling config (settings over env). `redis` is
 * optional — when provided, the kill-switch state is mirrored on refresh.
 */
export async function getCallingConfig(redis?: Redis): Promise<CallingConfig> {
  const now = Date.now();
  if (cache && cache.expiresAt > now) return cache.value;

  let rows: Array<{ key: string; value: unknown }>;
  try {
    rows = (await db.execute(sql`
      SELECT key, value FROM system_settings
      WHERE key IN (
        'calling.global_enabled',
        'calling.livekit_host',
        'calling.livekit_api_key',
        'calling.livekit_api_secret'
      )
    `)) as unknown as Array<{ key: string; value: unknown }>;
  } catch {
    // Keep serving the stale cache on a read failure; only fall all the
    // way back to env defaults when we never had a successful read.
    return cache?.value ?? envFallback();
  }

  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const enabledRaw = byKey.get('calling.global_enabled');
  const config: CallingConfig = {
    // Unset means enabled — the kill switch must be explicitly thrown.
    enabled: enabledRaw === undefined || enabledRaw === null || enabledRaw === true,
    livekitUrl: nonEmptyString(byKey.get('calling.livekit_host')) ?? env.LIVEKIT_URL,
    livekitApiKey:
      nonEmptyString(byKey.get('calling.livekit_api_key')) ?? env.LIVEKIT_API_KEY,
    livekitApiSecret:
      nonEmptyString(byKey.get('calling.livekit_api_secret')) ??
      env.LIVEKIT_API_SECRET,
  };
  cache = { value: config, expiresAt: now + CACHE_TTL_MS };

  if (redis) {
    redis
      .set(CALLING_ENABLED_REDIS_KEY, config.enabled ? '1' : '0')
      .catch(() => {
        /* mirror is best-effort */
      });
  }

  return config;
}

export async function isCallingEnabled(redis?: Redis): Promise<boolean> {
  return (await getCallingConfig(redis)).enabled;
}

/** Test hook — drop the cache so the next read hits the DB. */
export function __clearCallingConfigCache(): void {
  cache = null;
}
