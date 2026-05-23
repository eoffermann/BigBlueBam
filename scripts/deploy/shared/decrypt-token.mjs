// Decrypt an `enc:`-prefixed deploy token using the same scheme that
// the backend uses to encrypt it (see docs/plans/deploy-settings-contract.md).
//
// Algorithm (must match deploy-settings-contract.md::decryptToken byte-for-byte):
//
//   key = SHA256( SESSION_SECRET + 'deploy-token-key-v1' )    // 32 bytes
//   stored = 'enc:' + b64(iv) + ':' + b64(ciphertext) + ':' + b64(tag)
//   plaintext = AES-256-GCM-Decrypt(key, iv, ciphertext, tag)
//
// Returns null on any failure (wrong prefix, malformed segments, decrypt
// auth-tag mismatch, wrong key, etc.). Callers MUST treat null as
// "token not available" and continue without auth.
//
// Zero dependencies beyond node:crypto.

import { createDecipheriv, createHash } from 'node:crypto';

/**
 * Decrypt a stored deploy GitHub token.
 *
 * @param {string} encrypted - The stored value, including the `enc:` prefix.
 * @param {string} sessionSecret - The SESSION_SECRET env var the backend
 *   used to derive the key. Must be the exact same string the backend
 *   had at encryption time; if SESSION_SECRET has rotated since then,
 *   this returns null (and the caller is expected to treat the stored
 *   token as missing, prompt for a re-paste, etc.).
 * @returns {string | null} The plaintext token, or null on any failure.
 */
export function decryptDeployToken(encrypted, sessionSecret) {
  if (typeof encrypted !== 'string' || typeof sessionSecret !== 'string') {
    return null;
  }
  if (!encrypted.startsWith('enc:')) return null;

  // Strip the prefix and split on `:` to get the three base64 segments.
  // Note: base64 itself never contains a `:`, so a plain split is safe.
  const body = encrypted.slice('enc:'.length);
  const parts = body.split(':');
  if (parts.length !== 3) return null;

  const [ivB64, ctB64, tagB64] = parts;
  // iv and tag MUST be present; ct is allowed to be empty (empty
  // plaintext is a legal AES-GCM input and round-trips to "").
  if (!ivB64 || !tagB64 || ctB64 === undefined) return null;

  let iv;
  let ct;
  let tag;
  try {
    iv = Buffer.from(ivB64, 'base64');
    ct = Buffer.from(ctB64, 'base64');
    tag = Buffer.from(tagB64, 'base64');
  } catch {
    return null;
  }

  // AES-GCM uses a 12-byte (96-bit) IV and a 16-byte auth tag in the
  // canonical configuration that the contract specifies. We don't
  // enforce the IV length (createDecipheriv will throw on mismatch
  // anyway and we catch below), but the tag length must be set
  // explicitly because GCM allows shorter tags and node defaults to
  // accepting any length.
  if (tag.length !== 16) return null;

  // Derive the same 32-byte key as encryptToken in the contract:
  //   SHA256(SESSION_SECRET + 'deploy-token-key-v1')
  const key = createHash('sha256')
    .update(sessionSecret + 'deploy-token-key-v1')
    .digest();

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return plain.toString('utf8');
  } catch {
    // Auth-tag mismatch, wrong key, corrupt ciphertext — all surface
    // here as a generic decipher error. Caller treats this as missing.
    return null;
  }
}
