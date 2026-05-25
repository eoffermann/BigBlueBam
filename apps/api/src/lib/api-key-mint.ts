import { randomBytes } from 'crypto';
import argon2 from 'argon2';

// Mint and auth must agree — auth slices the incoming bearer to this length.
export const KEY_PREFIX_LENGTH = 8;

const TOKEN_PREFIX = {
  user_legacy: '', // POST /auth/api-keys: raw base64, no bbam_ wrap (backward compat).
  user: 'bbam_',
  service: 'bbam_svc_',
} as const;

export type ApiKeyKind = keyof typeof TOKEN_PREFIX;

export interface MintedApiKey {
  fullToken: string;
  keyPrefix: string;
  keyHash: string;
}

export async function mintApiKey(kind: ApiKeyKind): Promise<MintedApiKey> {
  const rawKey = randomBytes(32).toString('base64url');
  const fullToken = `${TOKEN_PREFIX[kind]}${rawKey}`;
  const keyPrefix = fullToken.slice(0, KEY_PREFIX_LENGTH);
  const keyHash = await argon2.hash(fullToken);
  return { fullToken, keyPrefix, keyHash };
}
