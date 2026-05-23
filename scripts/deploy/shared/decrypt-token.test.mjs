// Unit tests for decrypt-token.mjs.
//
// We encrypt a known plaintext in-test using the SAME algorithm the
// backend contract spells out, then assert the helper round-trips it.
// This guarantees: (a) the byte-for-byte recipe matches the contract
// and (b) any future drift in either side will surface immediately.

import { describe, expect, it } from 'vitest';
import {
  createCipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';
import { decryptDeployToken } from './decrypt-token.mjs';

/**
 * Local copy of the encryption side of the contract. Kept inline (not
 * imported) so this test fails loudly if the helper ever diverges from
 * the spec instead of silently consuming a re-exported encryptor.
 */
function encryptDeployToken(plaintext, sessionSecret) {
  const key = createHash('sha256')
    .update(sessionSecret + 'deploy-token-key-v1')
    .digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('base64')}:${ct.toString('base64')}:${tag.toString('base64')}`;
}

describe('decryptDeployToken', () => {
  const SESSION_SECRET =
    'test-session-secret-with-plenty-of-entropy-for-aes-key-derivation';

  it('round-trips a typical GitHub PAT', () => {
    const plaintext = 'ghp_1234567890abcdefghijklmnopqrstuvwxyzAB';
    const encrypted = encryptDeployToken(plaintext, SESSION_SECRET);
    expect(encrypted.startsWith('enc:')).toBe(true);
    expect(decryptDeployToken(encrypted, SESSION_SECRET)).toBe(plaintext);
  });

  it('round-trips an empty string', () => {
    const encrypted = encryptDeployToken('', SESSION_SECRET);
    expect(decryptDeployToken(encrypted, SESSION_SECRET)).toBe('');
  });

  it('round-trips a multi-byte UTF-8 string', () => {
    const plaintext = 'tok_émoji_🔐_value';
    const encrypted = encryptDeployToken(plaintext, SESSION_SECRET);
    expect(decryptDeployToken(encrypted, SESSION_SECRET)).toBe(plaintext);
  });

  it('returns null when the session secret is wrong', () => {
    const encrypted = encryptDeployToken('ghp_abc', SESSION_SECRET);
    expect(decryptDeployToken(encrypted, 'a-different-session-secret')).toBeNull();
  });

  it('returns null when the prefix is missing', () => {
    const encrypted = encryptDeployToken('ghp_abc', SESSION_SECRET);
    const stripped = encrypted.slice('enc:'.length); // no prefix
    expect(decryptDeployToken(stripped, SESSION_SECRET)).toBeNull();
  });

  it('returns null on malformed segment count', () => {
    expect(decryptDeployToken('enc:onlyone', SESSION_SECRET)).toBeNull();
    expect(decryptDeployToken('enc:one:two', SESSION_SECRET)).toBeNull();
    expect(decryptDeployToken('enc:a:b:c:d', SESSION_SECRET)).toBeNull();
  });

  it('returns null on empty segments', () => {
    expect(decryptDeployToken('enc:::', SESSION_SECRET)).toBeNull();
  });

  it('returns null when the auth tag is tampered', () => {
    const encrypted = encryptDeployToken('ghp_abc', SESSION_SECRET);
    const parts = encrypted.slice('enc:'.length).split(':');
    // Flip a byte in the tag (last segment) to simulate tampering.
    const tag = Buffer.from(parts[2], 'base64');
    tag[0] = tag[0] ^ 0xff;
    parts[2] = tag.toString('base64');
    const tampered = `enc:${parts.join(':')}`;
    expect(decryptDeployToken(tampered, SESSION_SECRET)).toBeNull();
  });

  it('returns null when the ciphertext is tampered', () => {
    const encrypted = encryptDeployToken('ghp_abc', SESSION_SECRET);
    const parts = encrypted.slice('enc:'.length).split(':');
    const ct = Buffer.from(parts[1], 'base64');
    if (ct.length > 0) ct[0] = ct[0] ^ 0xff;
    parts[1] = ct.toString('base64');
    const tampered = `enc:${parts.join(':')}`;
    expect(decryptDeployToken(tampered, SESSION_SECRET)).toBeNull();
  });

  it('returns null on non-string inputs', () => {
    expect(decryptDeployToken(null, SESSION_SECRET)).toBeNull();
    expect(decryptDeployToken(undefined, SESSION_SECRET)).toBeNull();
    expect(decryptDeployToken(12345, SESSION_SECRET)).toBeNull();
    expect(decryptDeployToken('enc:a:b:c', null)).toBeNull();
    expect(decryptDeployToken('enc:a:b:c', undefined)).toBeNull();
  });
});
