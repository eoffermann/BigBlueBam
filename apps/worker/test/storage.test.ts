import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInMemoryStorageDriver, StorageNotConfiguredError, type InMemoryStorageDriver } from '@bigbluebam/storage';

// Issue #176: the worker's storage helpers run on the shared @bigbluebam/storage
// driver (no private MinIO client, no default credentials). The tests inject an
// in-memory driver through the same hook production code reads from.
const storage = await import('../src/utils/storage.js');

let driver: InMemoryStorageDriver;
let dir: string;

beforeEach(async () => {
  driver = createInMemoryStorageDriver();
  storage.__setWorkerStorageDriverForTests(driver);
  dir = await mkdtemp(join(tmpdir(), 'worker-storage-'));
});

afterEach(async () => {
  storage.__setWorkerStorageDriverForTests(undefined);
  await rm(dir, { recursive: true, force: true });
});

describe('worker storage helpers on @bigbluebam/storage', () => {
  it('putObjectFromFile uploads a local file (the backup-upload path) with its content type', async () => {
    const src = join(dir, 'x.dump');
    await writeFile(src, Buffer.from('PGDMP-skipper'));
    await storage.putObjectFromFile('backups/platform/x.dump', src, 'application/octet-stream');
    const o = driver.objects.get('backups/platform/x.dump')!;
    expect(o.body.toString()).toBe('PGDMP-skipper');
    expect(o.contentType).toBe('application/octet-stream');
  });

  it('round-trips buffers, stats with content type, downloads to a file, lists and removes', async () => {
    await storage.putObjectBuffer('blip/caps/1.jpg', Buffer.from('jpeg'), 'image/jpeg');
    await storage.putObjectBuffer('blip/caps/2.jpg', Buffer.from('jpeg2'), 'image/jpeg');
    expect(await storage.statObject('blip/caps/1.jpg')).toEqual({ size: 4, contentType: 'image/jpeg' });
    expect((await storage.getObjectBuffer('blip/caps/2.jpg'))!.toString()).toBe('jpeg2');
    const dest = join(dir, 'out.jpg');
    expect(await storage.downloadObjectToFile('blip/caps/1.jpg', dest)).toBe(true);
    expect((await readFile(dest)).toString()).toBe('jpeg');
    expect((await storage.listObjectKeys('blip/caps/')).sort()).toEqual(['blip/caps/1.jpg', 'blip/caps/2.jpg']);
    expect(await storage.listObjectKeys('blip/caps/', 1)).toHaveLength(1);
    await storage.removeObject('blip/caps/1.jpg');
    expect(await storage.statObject('blip/caps/1.jpg')).toBeNull();
  });

  it('read helpers degrade on a missing object', async () => {
    expect(await storage.statObject('nope')).toBeNull();
    expect(await storage.getObjectBuffer('nope')).toBeNull();
    expect(await storage.downloadObjectToFile('nope', join(dir, 'n'))).toBe(false);
  });

  it('without storage configured: reads degrade, writes throw STORAGE_NOT_CONFIGURED', async () => {
    storage.__setWorkerStorageDriverForTests(null);
    expect(await storage.getObjectBuffer('k')).toBeNull();
    expect(await storage.listObjectKeys('p/')).toEqual([]);
    expect(await storage.presignedGetUrl('k')).toBeNull();
    await expect(storage.putObjectBuffer('k', Buffer.from('x'), 'text/plain')).rejects.toBeInstanceOf(
      StorageNotConfiguredError,
    );
  });

  it('the worker env has no default S3 credentials', () => {
    const env = storage.workerStorageEnv();
    if (!process.env.S3_ACCESS_KEY) expect(env.S3_ACCESS_KEY).toBeUndefined();
    if (!process.env.S3_SECRET_KEY) expect(env.S3_SECRET_KEY).toBeUndefined();
  });
});
