// Key material derived from the stable secrets (spec 9.4). Lazy and memoized so modules that
// only import types never touch the environment. The HMAC and seal keys never leave bastion-api.

import { createHmac } from 'node:crypto';
import { env } from '../env.js';
import { canonicalJson, sealSignerFromSeed, sha256Hex, signingKeyIdOf, type SealSigner } from './ledger-canonical.js';

let signer: SealSigner | null = null;

export function currentSealSigner(): SealSigner {
  if (!signer) signer = sealSignerFromSeed(env.BASTION_SEAL_SIGNING_KEY);
  return signer;
}

/** Every published key: the current one plus BASTION_SEAL_RETIRED_PUBLIC_KEYS. */
export function publishedSealKeys(): Array<{ signing_key_id: string; public_key_hex: string; current: boolean }> {
  const current = currentSealSigner();
  const out = [{ signing_key_id: current.keyId, public_key_hex: current.publicKeyHex, current: true }];
  for (const raw of (env.BASTION_SEAL_RETIRED_PUBLIC_KEYS ?? '').split(',')) {
    const hex = raw.trim().toLowerCase();
    if (!hex || hex === current.publicKeyHex) continue;
    out.push({ signing_key_id: signingKeyIdOf(hex), public_key_hex: hex, current: false });
  }
  return out;
}

export function publishedSealKeyMap(): Map<string, string> {
  return new Map(publishedSealKeys().map((k) => [k.signing_key_id, k.public_key_hex]));
}

/** The personal-data HMAC key id: a fingerprint, so a key change is detectable (`key_changed`). */
export function pdHmacKeyId(): string {
  return `pd:${sha256Hex(env.BASTION_PD_HMAC_KEY).slice(0, 12)}`;
}

/** The commitment over a holder's personal data (spec 3.4). */
export function pdHmac(data: unknown): string {
  return createHmac('sha256', Buffer.from(env.BASTION_PD_HMAC_KEY, 'hex')).update(canonicalJson(data)).digest('hex');
}
