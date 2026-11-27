// An in-memory StorageDriver for tests (issue #163). Services under test inject
// it through their __set*StorageDriverForTests hook so a test exercises the
// same @bigbluebam/storage path the code uses, and can assert the objects it
// wrote, instead of mocking the underlying MinIO client.

import { Readable } from 'node:stream';
import type { ObjectStat, PutResult, StorageCapabilities, StorageDriver } from './driver.js';

export interface InMemoryObject {
  body: Buffer;
  contentType: string;
  modifiedAt: Date;
}

export interface InMemoryStorageDriver extends StorageDriver {
  /** Every stored object, by key. Tests read and seed this directly. */
  readonly objects: Map<string, InMemoryObject>;
}

const CAPABILITIES: StorageCapabilities = {
  supportsPresignedGet: false,
  supportsPresignedPut: false,
  supportsMultipart: false,
  supportsServerSideCopy: true,
  supportsVersioning: false,
  integrityToken: 'none',
  canServeHotMedia: false,
};

async function toBuffer(body: NodeJS.ReadableStream | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body as AsyncIterable<Buffer | string>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function notFound(key: string): Error {
  // Same shape isStorageNotFoundError recognizes for S3 (code NoSuchKey).
  return Object.assign(new Error(`Object not found: ${key}`), { code: 'NoSuchKey' });
}

export function createInMemoryStorageDriver(): InMemoryStorageDriver {
  const objects = new Map<string, InMemoryObject>();
  const statOf = (key: string, o: InMemoryObject): ObjectStat => ({
    key,
    size: o.body.length,
    integrity: '',
    modifiedAt: o.modifiedAt,
  });
  return {
    kind: 'local',
    capabilities: CAPABILITIES,
    objects,
    async healthCheck() {
      return { ok: true, latencyMs: 0 };
    },
    async put(key, body, opts): Promise<PutResult> {
      const buf = await toBuffer(body);
      objects.set(key, { body: buf, contentType: opts?.contentType ?? 'application/octet-stream', modifiedAt: new Date() });
      return { key, size: buf.length, integrity: '' };
    },
    async getStream(key) {
      const o = objects.get(key);
      if (!o) throw notFound(key);
      return { stream: Readable.from([o.body]), contentType: o.contentType, size: o.body.length };
    },
    async getRange(key, start, end) {
      const o = objects.get(key);
      if (!o) throw notFound(key);
      return {
        stream: Readable.from([o.body.subarray(start, end + 1)]),
        contentType: o.contentType,
        size: Math.max(0, Math.min(end, o.body.length - 1) - start + 1),
        total: o.body.length,
      };
    },
    async stat(key) {
      const o = objects.get(key);
      return o ? statOf(key, o) : null;
    },
    async delete(key) {
      objects.delete(key);
    },
    async list(prefix) {
      return {
        objects: [...objects.entries()].filter(([k]) => k.startsWith(prefix)).map(([k, o]) => statOf(k, o)),
      };
    },
    async copyTo(destKey, sourceKey) {
      const o = objects.get(sourceKey);
      if (!o) throw notFound(sourceKey);
      objects.set(destKey, { ...o, modifiedAt: new Date() });
    },
  };
}
