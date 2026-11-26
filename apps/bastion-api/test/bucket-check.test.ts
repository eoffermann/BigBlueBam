import { describe, it, expect, vi } from 'vitest';
import type { StorageDriver } from '@bigbluebam/storage';
import { getBucketCheckStatus, runBucketCheck } from '../src/boot/bucket-check.js';
import { createBastionStorage, isStorageConfigured } from '../src/lib/storage.js';

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** In-memory driver; `fail` makes one method throw, `hang` makes one never settle. */
function fakeDriver(opts: { fail?: 'put' | 'stat' | 'delete'; hang?: 'put'; wrongSize?: boolean } = {}) {
  const objects = new Map<string, Buffer>();
  const calls: string[] = [];
  const driver = {
    kind: 'local',
    capabilities: {},
    healthCheck: async () => ({ ok: true, latencyMs: 0 }),
    put: async (key: string, body: Buffer) => {
      calls.push(`put:${key}`);
      if (opts.hang === 'put') return new Promise(() => {});
      if (opts.fail === 'put') throw new Error('AccessDenied');
      objects.set(key, body);
      return { key, size: body.length, integrity: 'etag' };
    },
    stat: async (key: string) => {
      calls.push(`stat:${key}`);
      if (opts.fail === 'stat') throw new Error('stat exploded');
      const b = objects.get(key);
      if (!b) return null;
      return { key, size: opts.wrongSize ? b.length + 1 : b.length, integrity: 'etag', modifiedAt: new Date() };
    },
    delete: async (key: string) => {
      calls.push(`delete:${key}`);
      if (opts.fail === 'delete') throw new Error('delete refused');
      objects.delete(key);
    },
    getStream: async () => {
      throw new Error('unused');
    },
    list: async () => ({ objects: [] }),
  } as unknown as StorageDriver;
  return { driver, objects, calls };
}

describe('own-bucket boot check (spec 9.1)', () => {
  it('put, stat, delete in that order on the Bastion bucket, leaving nothing behind', async () => {
    const { driver, objects, calls } = fakeDriver();
    const log = logger();
    const r = await runBucketCheck(driver, 'bigbluebam-bastion', log);
    expect(r.status).toBe('ok');
    expect(r.bucket).toBe('bigbluebam-bastion');
    expect(calls.map((c) => c.split(':')[0])).toEqual(['put', 'stat', 'delete']);
    expect(new Set(calls.map((c) => c.split(':')[1])).size).toBe(1);
    expect(calls[0]).toMatch(/^put:_bastion_boot_check\//);
    expect(objects.size).toBe(0);
    expect(getBucketCheckStatus().status).toBe('ok');
  });

  it('a failing write logs a plain error, records failed, and does not throw', async () => {
    const { driver } = fakeDriver({ fail: 'put' });
    const log = logger();
    const r = await runBucketCheck(driver, 'bigbluebam-bastion', log);
    expect(r.status).toBe('failed');
    expect(r.message).toBe(
      'Bastion could not write a test file to its evidence bucket "bigbluebam-bastion". Bastion is running, but uploading evidence will fail until storage is fixed. Check S3_ENDPOINT, the S3 keys, and BASTION_S3_BUCKET.',
    );
    expect(r.detail).toBe('AccessDenied');
    expect(log.error).toHaveBeenCalledWith(expect.objectContaining({ bucket_check_status: 'failed' }), r.message);
    expect(getBucketCheckStatus().status).toBe('failed');
  });

  it('a failing stat names the step and cleans up the probe object', async () => {
    const { driver, objects } = fakeDriver({ fail: 'stat' });
    const r = await runBucketCheck(driver, 'b-bastion', logger());
    expect(r.status).toBe('failed');
    expect(r.message).toContain('could not read back the test file from');
    expect(objects.size).toBe(0);
  });

  it('a size mismatch on read-back is a failure', async () => {
    const { driver } = fakeDriver({ wrongSize: true });
    const r = await runBucketCheck(driver, 'b-bastion', logger());
    expect(r.status).toBe('failed');
    expect(r.detail).toMatch(/size/);
  });

  it('a failing delete names the delete step', async () => {
    const { driver } = fakeDriver({ fail: 'delete' });
    const r = await runBucketCheck(driver, 'b-bastion', logger());
    expect(r.status).toBe('failed');
    expect(r.message).toContain('could not delete the test file from');
  });

  it('a hung storage endpoint times out instead of stalling', async () => {
    const { driver } = fakeDriver({ hang: 'put' });
    const r = await runBucketCheck(driver, 'b-bastion', logger(), { timeoutMs: 20 });
    expect(r.status).toBe('failed');
    expect(r.detail).toMatch(/did not answer within 20 ms/);
  });

  it('no storage configured: not_configured with a warning, never failed', async () => {
    const log = logger();
    const r = await runBucketCheck(null, 'bigbluebam-bastion', log);
    expect(r.status).toBe('not_configured');
    expect(r.message).toMatch(/^Evidence storage isn't set up/);
    expect(log.warn).toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe('Bastion storage driver selection', () => {
  const base = { S3_REGION: 'us-east-1', BASTION_S3_BUCKET: 'bigbluebam-bastion' };

  it('is null when any S3 credential is missing', () => {
    expect(isStorageConfigured(base)).toBe(false);
    expect(createBastionStorage({ ...base, S3_ENDPOINT: 'http://minio:9000', S3_ACCESS_KEY: 'k' })).toBeNull();
  });

  it('targets BASTION_S3_BUCKET, not the shared uploads bucket', () => {
    const d = createBastionStorage({
      ...base,
      S3_ENDPOINT: 'http://minio:9000',
      S3_ACCESS_KEY: 'k',
      S3_SECRET_KEY: 's',
    });
    expect(d).not.toBeNull();
    expect((d as unknown as { bucket: string }).bucket).toBe('bigbluebam-bastion');
  });
});
