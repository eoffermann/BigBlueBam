import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Envelope encryption for provider credentials (Bin master §5.2, §16). The
 * ciphertext never leaves the server; only a fingerprint + masked hint are
 * returned to the UI. AES-256-GCM; the 16-byte auth tag is appended to the
 * ciphertext. The master key (BIN_SECRETS_KEY) is hashed to a fixed 32 bytes so
 * any reasonable key form (hex, base64, passphrase) works deterministically.
 */
const ALGO = 'aes-256-gcm';
const IV_LEN = 12;
const TAG_LEN = 16;

function deriveKey(masterKey: string): Buffer {
  return createHash('sha256').update(masterKey, 'utf8').digest();
}

export interface EncryptedSecret {
  ciphertext: string; // base64(cipherbytes || authTag)
  iv: string; // base64
  keyId: string;
}

export function encryptSecret(bundle: unknown, masterKey: string, keyId: string): EncryptedSecret {
  const key = deriveKey(masterKey);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(bundle), 'utf8');
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([ct, tag]).toString('base64'),
    iv: iv.toString('base64'),
    keyId,
  };
}

export function decryptSecret<T = unknown>(enc: EncryptedSecret, masterKey: string): T {
  const key = deriveKey(masterKey);
  const iv = Buffer.from(enc.iv, 'base64');
  const data = Buffer.from(enc.ciphertext, 'base64');
  const ct = data.subarray(0, data.length - TAG_LEN);
  const tag = data.subarray(data.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}

/** sha256 of an access-key id, shown in the UI in place of the secret. */
export function fingerprint(accessKeyId: string): string {
  return createHash('sha256').update(accessKeyId, 'utf8').digest('hex');
}

/** A masked hint like "AKIA…7Q3F" for display. */
export function displayHint(accessKeyId: string): string {
  if (accessKeyId.length <= 8) return `${accessKeyId.slice(0, 2)}…`;
  return `${accessKeyId.slice(0, 4)}…${accessKeyId.slice(-4)}`;
}
