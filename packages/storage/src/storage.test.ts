import { describe, it, expect } from 'vitest';
import { parseProviderConfig, s3ConfigSchema, rcloneConfigSchema } from './config.js';
import { encryptSecret, decryptSecret, fingerprint, displayHint } from './secrets.js';
import { createDriver, createBootstrapDriver } from './factory.js';
import { buildStorageKey } from './index.js';
import { S3Driver } from './s3-driver.js';

describe('config schemas', () => {
  it('accepts a valid s3 config and defaults the region', () => {
    const cfg = s3ConfigSchema.parse({ endpoint: 'https://s3.example.com', bucket: 'b' });
    expect(cfg.region).toBe('us-east-1');
  });
  it('rejects a non-URL endpoint and a missing bucket', () => {
    expect(s3ConfigSchema.safeParse({ endpoint: 'not-a-url', bucket: 'b' }).success).toBe(false);
    expect(s3ConfigSchema.safeParse({ endpoint: 'https://x' }).success).toBe(false);
  });
  it('validates an rclone config', () => {
    expect(rcloneConfigSchema.safeParse({ remoteType: 'drive', remoteName: 'gdrive' }).success).toBe(true);
    expect(rcloneConfigSchema.safeParse({ remoteType: 'drive' }).success).toBe(false);
  });
  it('parseProviderConfig dispatches by kind', () => {
    const r = parseProviderConfig('s3', { endpoint: 'https://s3.example.com', bucket: 'b' });
    expect(r.kind).toBe('s3');
  });
});

describe('secrets envelope encryption', () => {
  const master = 'a-32-plus-byte-master-key-for-tests-0123456789';
  it('round-trips an encrypted bundle', () => {
    const enc = encryptSecret({ accessKey: 'AKIA123', secretKey: 'shh' }, master, 'local-1');
    expect(enc.keyId).toBe('local-1');
    const dec = decryptSecret<{ accessKey: string; secretKey: string }>(enc, master);
    expect(dec).toEqual({ accessKey: 'AKIA123', secretKey: 'shh' });
  });
  it('fails to decrypt with the wrong master key', () => {
    const enc = encryptSecret({ x: 1 }, master, 'local-1');
    expect(() => decryptSecret(enc, 'a-different-master-key-aaaaaaaaaaaaaaaaaaa')).toThrow();
  });
  it('produces a deterministic fingerprint and a masked hint', () => {
    expect(fingerprint('AKIA123')).toBe(fingerprint('AKIA123'));
    expect(fingerprint('AKIA123')).not.toBe(fingerprint('AKIA124'));
    expect(displayHint('AKIA00007Q3F')).toBe('AKIA…7Q3F');
  });
});

describe('driver factory', () => {
  const secret = { accessKey: 'k', secretKey: 's' };
  it('builds an S3Driver for s3 and local kinds', () => {
    const s3 = createDriver({ kind: 's3', config: { endpoint: 'https://s3.example.com', bucket: 'b' } }, secret);
    expect(s3).toBeInstanceOf(S3Driver);
    expect(s3.kind).toBe('s3');
    expect(s3.capabilities.canServeHotMedia).toBe(true);
    expect(s3.capabilities.integrityToken).toBe('etag');

    const local = createDriver({ kind: 'local', config: { endpoint: 'http://minio:9000', bucket: 'b' } }, secret);
    expect(local.kind).toBe('local');
  });
  it('refuses to construct an rclone driver for the hot path', () => {
    expect(() => createDriver({ kind: 'rclone', config: { remoteType: 'drive', remoteName: 'g' } }, secret)).toThrow(
      /backup-only/,
    );
  });
  it('builds a bootstrap local driver from S3_* env', () => {
    const d = createBootstrapDriver({
      S3_ENDPOINT: 'http://minio:9000',
      S3_REGION: 'us-east-1',
      S3_BUCKET: 'bigbluebam-uploads',
      S3_ACCESS_KEY: 'minioadmin',
      S3_SECRET_KEY: 'minioadmin',
    });
    expect(d.kind).toBe('local');
  });
});

describe('buildStorageKey', () => {
  it('builds a namespaced key and sanitizes the filename', () => {
    expect(buildStorageKey('org1', 'bin', 'asset1', 'uuid', 'my file (1).csv')).toBe(
      'org1/bin/asset1/uuid-my_file__1_.csv',
    );
  });
});
