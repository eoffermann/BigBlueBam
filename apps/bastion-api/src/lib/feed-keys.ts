// Per-feed credentials (spec 3.5, Blip's ingest-key pattern). A token is
//   bbf_<key_id>_<secret>
// where key_id (16 hex) is public and indexed, and only HMAC-SHA256(pepper, secret) is stored, so
// a database read yields no working key. The pepper is BASTION_FEED_KEY_PEPPER (a stable secret).
// Pure: the pepper is passed in, so this is unit-tested without the environment.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { BASTION_FEED_KEY_PREFIX } from '@bigbluebam/shared';

export interface MintedFeedKey {
  token: string;
  key_id: string;
  secret_hmac: string;
  fingerprint: string;
  last4: string;
}

export function feedSecretHmac(pepperHex: string, secret: string): string {
  return createHmac('sha256', Buffer.from(pepperHex, 'hex')).update(secret, 'utf8').digest('hex');
}

export function mintFeedKey(pepperHex: string): MintedFeedKey {
  const key_id = randomBytes(8).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const token = `${BASTION_FEED_KEY_PREFIX}${key_id}_${secret}`;
  return {
    token,
    key_id,
    secret_hmac: feedSecretHmac(pepperHex, secret),
    fingerprint: createHash('sha256').update(token).digest('hex').slice(0, 16),
    last4: token.slice(-4),
  };
}

/** Split `bbf_<key_id>_<secret>`; null for anything else (never throws on hostile input). */
export function parseFeedToken(raw: string | undefined | null): { key_id: string; secret: string } | null {
  if (!raw) return null;
  const token = raw.startsWith('Bearer ') ? raw.slice(7).trim() : raw.trim();
  if (!token.startsWith(BASTION_FEED_KEY_PREFIX) || token.length > 200) return null;
  const rest = token.slice(BASTION_FEED_KEY_PREFIX.length);
  const m = /^([0-9a-f]{16})_([A-Za-z0-9_-]{20,})$/.exec(rest);
  const keyId = m?.[1];
  const secret = m?.[2];
  if (!keyId || !secret) return null;
  return { key_id: keyId, secret };
}

/** Constant-time comparison of the presented secret against the stored HMAC. */
export function verifyFeedSecret(pepperHex: string, secret: string, storedHmac: string): boolean {
  const a = Buffer.from(feedSecretHmac(pepperHex, secret), 'hex');
  let b: Buffer;
  try {
    b = Buffer.from(storedHmac, 'hex');
  } catch {
    return false;
  }
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Is this key allowed to push at `now`? active, or in its rotation grace window. */
export function keyUsable(key: { status: string; grace_expires_at: Date | null; revoked_at: Date | null }, now: Date): boolean {
  if (key.revoked_at || key.status === 'revoked') return false;
  if (key.status === 'active') return true;
  return key.status === 'grace' && key.grace_expires_at !== null && key.grace_expires_at.getTime() > now.getTime();
}

/** The per-feed daily quota (spec 3.5): the counter resets when the UTC day changes. */
export function quotaAfter(
  feed: { quota_day: string | null; records_on_quota_day: number; daily_record_quota: number },
  today: string,
  adding: number,
): { allowed: boolean; used: number; remaining: number } {
  const used = feed.quota_day === today ? feed.records_on_quota_day : 0;
  const next = used + adding;
  if (next > feed.daily_record_quota) return { allowed: false, used, remaining: Math.max(0, feed.daily_record_quota - used) };
  return { allowed: true, used: next, remaining: feed.daily_record_quota - next };
}
