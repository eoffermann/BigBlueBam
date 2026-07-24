import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the minio client so the worker storage helper runs without a real object
// store. The module instantiates one `new Minio.Client(...)` at import time, so
// the mocked methods are shared across every helper call.
const bucketExists = vi.fn();
const makeBucket = vi.fn();
const fPutObject = vi.fn();

vi.mock('minio', () => ({
  Client: vi.fn(() => ({ bucketExists, makeBucket, fPutObject })),
}));

const storage = await import('../src/utils/storage.js');

beforeEach(() => {
  bucketExists.mockReset();
  makeBucket.mockReset();
  fPutObject.mockReset();
  storage.__resetEnsuredBucketsForTest();
});

describe('ensureBucket', () => {
  it('creates the bucket when it does not exist', async () => {
    bucketExists.mockResolvedValue(false);
    await storage.ensureBucket();
    expect(makeBucket).toHaveBeenCalledOnce();
  });

  it('does not create the bucket when it already exists', async () => {
    bucketExists.mockResolvedValue(true);
    await storage.ensureBucket();
    expect(makeBucket).not.toHaveBeenCalled();
  });

  it('checks the store only once per bucket (cached)', async () => {
    bucketExists.mockResolvedValue(true);
    await storage.ensureBucket();
    await storage.ensureBucket();
    expect(bucketExists).toHaveBeenCalledOnce();
  });
});

describe('putObjectFromFile', () => {
  it('ensures the bucket exists before uploading (the backup-upload path)', async () => {
    bucketExists.mockResolvedValue(false);
    fPutObject.mockResolvedValue(undefined);
    await storage.putObjectFromFile('backups/platform/x.dump', '/tmp/x.dump', 'application/octet-stream');
    // makeBucket must run before the upload, or fPutObject hits NoSuchBucket.
    expect(makeBucket).toHaveBeenCalledOnce();
    expect(fPutObject).toHaveBeenCalledOnce();
    expect(makeBucket.mock.invocationCallOrder[0]).toBeLessThan(fPutObject.mock.invocationCallOrder[0]);
  });
});
