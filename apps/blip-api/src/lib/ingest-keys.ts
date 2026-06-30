/**
 * Blip ingest-key primitives (Blip §10). Token format:
 *   blip_<key_id>_<secret>
 *     key_id  -> public, indexed lookup id (cleartext, embedded in the token)
 *     secret  -> high-entropy; verified by constant-time HMAC compare
 *
 * Because the secret is high-entropy (we generate it), a fast keyed HMAC is the
 * correct verification primitive on the hot path. A slow KDF (argon2/bcrypt) is
 * for low-entropy human passwords and would be wrong here.
 */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { nanoid } from 'nanoid';

export type ParsedToken = { keyId: string; secret: string } | null;

/** Parse a token by string split, no DB. Returns null if malformed. */
export function parseToken(token: string | undefined): ParsedToken {
  if (!token || !token.startsWith('blip_')) return null;
  const rest = token.slice('blip_'.length);
  const sep = rest.indexOf('_');
  if (sep <= 0) return null;
  const keyId = rest.slice(0, sep);
  const secret = rest.slice(sep + 1);
  if (!keyId || !secret) return null;
  return { keyId, secret };
}

export function hmacSecret(secret: string, pepper: string): string {
  return createHmac('sha256', pepper).update(secret).digest('hex');
}

/** Constant-time compare of HMAC(secret) against the stored hmac. */
export function verifySecret(secret: string, storedHmac: string, pepper: string): boolean {
  const computed = hmacSecret(secret, pepper);
  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(storedHmac, 'hex');
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

export type MintedKey = {
  token: string; // shown once
  keyId: string;
  secretHmac: string;
  last4: string;
  fingerprint: string;
};

/** Mint a new ingest key. The full token is returned once and never stored. */
export function mintKey(pepper: string): MintedKey {
  const keyId = nanoid(8).replace(/[^a-zA-Z0-9]/g, 'a');
  const secret = randomBytes(24).toString('base64url');
  const token = `blip_${keyId}_${secret}`;
  return {
    token,
    keyId,
    secretHmac: hmacSecret(secret, pepper),
    last4: secret.slice(-4),
    fingerprint: createHmac('sha256', pepper).update(token).digest('hex').slice(0, 16),
  };
}

export const KEY_CACHE_PREFIX = 'blip:ikey:';
export const KEY_INVALIDATE_CHANNEL = 'blip:ikey:invalidate';
export const KEY_CACHE_TTL_SEC = 60;

export type KeyCacheEntry = {
  tracked_app_id: string;
  org_id: string;
  key_db_id: string;
  secret_hmac: string;
  status: string;
  collection_enabled: boolean;
  rate_limit: Record<string, unknown> | null;
  transform_version: number;
};
