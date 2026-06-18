/**
 * Symmetric secret-at-rest helper for external-calendar connection material.
 *
 * ICS feed URLs frequently embed a private token (e.g. Google's "secret
 * address in iCal format" or an Outlook published-calendar GUID), and the
 * Google/Outlook OAuth slots store access/refresh tokens. All of that is
 * encrypted at rest with AES-256-GCM keyed off SESSION_SECRET, so a DB dump
 * never leaks a usable credential.
 *
 * Format of an encrypted value: `enc:v1:<ivB64>:<tagB64>:<cipherB64>`.
 * Plaintext that does not carry the `enc:v1:` prefix is returned as-is by
 * decryptSecret(), which keeps the path safe across the rollout (rows written
 * before this helper existed, or values we deliberately leave in the clear).
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../env.js';

const PREFIX = 'enc:v1:';

function key(): Buffer {
  // SESSION_SECRET is required (min 32 chars) — derive a fixed 32-byte AES key.
  return createHash('sha256').update(env.SESSION_SECRET).digest();
}

export function encryptSecret(plaintext: string | null | undefined): string | null {
  if (plaintext === null || plaintext === undefined || plaintext === '') return null;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

export function decryptSecret(stored: string | null | undefined): string | null {
  if (stored === null || stored === undefined) return null;
  if (!stored.startsWith(PREFIX)) return stored; // legacy/plaintext passthrough
  const body = stored.slice(PREFIX.length);
  const [ivB64, tagB64, dataB64] = body.split(':');
  if (!ivB64 || !tagB64 || !dataB64) return null;
  try {
    const decipher = createDecipheriv('aes-256-gcm', key(), Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    return null; // tampered or wrong key — fail closed
  }
}
