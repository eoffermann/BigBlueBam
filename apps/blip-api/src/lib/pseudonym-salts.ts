/**
 * Period salts for the `pseudonymize` transform (see lib/transform.ts). One
 * random 256-bit salt per (tracked_app, period, period label), held ONLY in
 * Redis with a TTL that ends exactly when the period ends, so the salt (and with
 * it any way to re-link that period's pseudonyms) disappears on schedule. Never
 * written to Postgres, logs, or backups.
 *
 * Every blip-api instance converges on the same salt via SET NX. If Redis is
 * unavailable the lookup yields null and the transform drops the field: we
 * would rather lose an id than store it raw.
 */
import { randomBytes } from 'node:crypto';
import type Redis from 'ioredis';
import { periodWindow, type PseudonymPeriod, type SaltLookup } from './transform.js';

export const SALT_KEY_PREFIX = 'blip:psalt:';

export function saltKey(trackedAppId: string, period: PseudonymPeriod, label: string): string {
  return `${SALT_KEY_PREFIX}${trackedAppId}:${period}:${label}`;
}

async function getOrCreateSalt(
  redis: Redis,
  trackedAppId: string,
  period: PseudonymPeriod,
  at: Date,
): Promise<string | null> {
  const { label, endsAt } = periodWindow(period, at);
  const key = saltKey(trackedAppId, period, label);
  const ttlMs = endsAt.getTime() - at.getTime();
  if (ttlMs <= 0) return null;
  try {
    const existing = await redis.get(key);
    if (existing) return existing;
    await redis.set(key, randomBytes(32).toString('hex'), 'PX', ttlMs, 'NX');
    return await redis.get(key); // re-read: another instance may have won the NX race
  } catch {
    return null;
  }
}

/** Resolve the salts a batch needs up front, so the transform itself stays sync. */
export async function resolveSalts(
  redis: Redis,
  trackedAppId: string,
  periods: PseudonymPeriod[],
  at: Date,
): Promise<SaltLookup> {
  const found = new Map<PseudonymPeriod, string | null>();
  for (const p of periods) found.set(p, await getOrCreateSalt(redis, trackedAppId, p, at));
  return (p) => found.get(p) ?? null;
}
