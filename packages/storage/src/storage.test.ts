import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { parseProviderConfig, s3ConfigSchema, rcloneConfigSchema } from './config.js';
import { encryptSecret, decryptSecret, fingerprint, displayHint } from './secrets.js';
import {
  createDriver,
  createBootstrapDriver,
  createEnvBootstrapDriver,
  getEnvBootstrapDriver,
  isStorageConfigured,
  requireEnvBootstrapDriver,
  __setEnvBootstrapDriverForTests,
} from './factory.js';
import { buildStorageKey, billInvoicePdfKey } from './index.js';
import { S3Driver } from './s3-driver.js';
import {
  StorageNotConfiguredError,
  StorageTimeoutError,
  isStorageNotFoundError,
  withStorageTimeout,
} from './errors.js';

describe('env-driven bootstrap driver (issue #164)', () => {
  const full = () => ({
    S3_ENDPOINT: 'http://minio:9000',
    S3_ACCESS_KEY: 'ak',
    S3_SECRET_KEY: 'sk',
    S3_REGION: 'us-east-1',
    S3_BUCKET: 'bigbluebam-uploads',
  });

  it('one configured rule: endpoint, both credentials and a bucket', () => {
    expect(isStorageConfigured(full())).toBe(true);
    for (const k of ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET'] as const) {
      expect(isStorageConfigured({ ...full(), [k]: '' }), k).toBe(false);
      expect(createEnvBootstrapDriver({ ...full(), [k]: undefined as unknown as string }), k).toBeNull();
    }
  });

  it('memoizes per env object, and require throws a 503 STORAGE_NOT_CONFIGURED', () => {
    const env = full();
    const d = getEnvBootstrapDriver(env);
    expect(d).toBeInstanceOf(S3Driver);
    expect(getEnvBootstrapDriver(env)).toBe(d);
    expect(getEnvBootstrapDriver(full())).not.toBe(d);
    const missing = { ...full(), S3_SECRET_KEY: undefined };
    expect(getEnvBootstrapDriver(missing)).toBeNull();
    const err = (() => {
      try {
        requireEnvBootstrapDriver(missing);
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(StorageNotConfiguredError);
    expect(err).toMatchObject({ statusCode: 503, code: 'STORAGE_NOT_CONFIGURED' });
  });

  it('the test hook pins and unpins a driver for one env', () => {
    const env = full();
    const fake = { kind: 'local' } as unknown as ReturnType<typeof getEnvBootstrapDriver>;
    __setEnvBootstrapDriverForTests(env, fake);
    expect(getEnvBootstrapDriver(env)).toBe(fake);
    __setEnvBootstrapDriverForTests(env, null);
    expect(getEnvBootstrapDriver(env)).toBeNull();
    __setEnvBootstrapDriverForTests(env, undefined);
    expect(getEnvBootstrapDriver(env)).toBeInstanceOf(S3Driver);
  });

  it('isStorageNotFoundError recognizes the S3 not-found codes only', () => {
    for (const code of ['NoSuchKey', 'NotFound', 'NoSuchObject']) expect(isStorageNotFoundError({ code })).toBe(true);
    expect(isStorageNotFoundError({ code: 'AccessDenied' })).toBe(false);
    expect(isStorageNotFoundError(null)).toBe(false);
  });
});

describe('withStorageTimeout (issue #169)', () => {
  it('passes a result through, and rejects a stalled call with a 504 STORAGE_TIMEOUT', async () => {
    expect(await withStorageTimeout('put', Promise.resolve(7), 50)).toBe(7);
    const err = await withStorageTimeout('put', new Promise(() => {}), 20).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageTimeoutError);
    expect(err).toMatchObject({ statusCode: 504, code: 'STORAGE_TIMEOUT', operation: 'put', timeoutMs: 20 });
  });

  it('propagates the call own error unchanged', async () => {
    await expect(withStorageTimeout('put', Promise.reject(new Error('NoSuchBucket')), 50)).rejects.toThrow('NoSuchBucket');
  });
});

describe('shared object keys (issue #148)', () => {
  it('billInvoicePdfKey is the key the worker writes and bill-api reads', () => {
    expect(billInvoicePdfKey('11111111-1111-1111-1111-111111111111')).toBe(
      'bill/invoices/11111111-1111-1111-1111-111111111111.pdf',
    );
  });
});

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

describe('S3Driver.list pages (#309, #313)', () => {
  /** A fake minio listing: an object-mode stream over sorted names after startAfter, counting what it produced. */
  function fakeClient(names: string[]) {
    const seen = { produced: 0, startAfter: [] as Array<string | undefined>, destroyed: 0 };
    const client = {
      listObjectsV2(_bucket: string, prefix: string, _recursive: boolean, startAfter?: string) {
        seen.startAfter.push(startAfter);
        const rest = names.filter((n) => n.startsWith(prefix) && (!startAfter || n > startAfter));
        let i = 0;
        const s = new Readable({
          objectMode: true,
          read() {
            if (i >= rest.length) return this.push(null);
            seen.produced += 1;
            this.push({ name: rest[i++], size: 1, etag: 'e', lastModified: new Date(0) });
          },
          destroy(err, cb) {
            seen.destroyed += 1;
            cb(err);
          },
        });
        return s;
      },
    };
    return { client, seen };
  }

  const driverWith = (client: unknown, basePath?: string) => {
    const d = new S3Driver({ kind: 's3', endpoint: 'http://minio:9000', region: 'us-east-1', bucket: 'b', accessKey: 'a', secretKey: 's', basePath });
    (d as unknown as { client: unknown }).client = client;
    return d;
  };

  it('stops the minio stream once a page is full, so listing N keys is linear', async () => {
    const names = Array.from({ length: 2500 }, (_, i) => `seals/${String(i).padStart(5, '0')}.json`);
    const { client, seen } = fakeClient(names);
    const d = driverWith(client);
    const keys: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await d.list('seals/', cursor);
      keys.push(...page.objects.map((o) => o.key));
      cursor = page.cursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(keys).toEqual(names);
    expect(pages).toBe(3);
    // Without the early stop every page streams the whole remainder: 2500 + 1500 + 500.
    expect(seen.produced).toBeLessThanOrEqual(2500 + 2 * 16);
    expect(seen.destroyed).toBeGreaterThanOrEqual(2);
  });

  it('puts the base path back on the startAfter cursor', async () => {
    const names = Array.from({ length: 1500 }, (_, i) => `mirror/evidence/${String(i).padStart(5, '0')}`);
    const { client, seen } = fakeClient(names);
    const d = driverWith(client, 'mirror');
    const first = await d.list('evidence/');
    expect(first.objects[0]!.key).toBe('evidence/00000');
    expect(first.cursor).toBe('evidence/00999');
    const second = await d.list('evidence/', first.cursor);
    expect(seen.startAfter[1]).toBe('mirror/evidence/00999');
    expect(second.objects).toHaveLength(500);
    expect(second.objects[0]!.key).toBe('evidence/01000');
  });
});
