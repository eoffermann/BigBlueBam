// bin-api as server.ts wires it (cookie, auth, permissions, the /v1 asset, folder and scan
// routes), minus the network edges a unit run has no use for: Redis is a recording stub, the
// per-action permission resolver runs in 'off' mode (requireAuth and requireScope still apply),
// and storage is an in-memory driver (memoryDriver below) that callers install by mocking
// ../../src/lib/storage.js. Callers mock ../../src/env.js before importing this.
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fp from 'fastify-plugin';

export async function buildBinApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: 'c'.repeat(32) });
  await app.register(
    fp(
      async (f) => {
        f.decorate('redis', { publish: async () => 1 } as never);
      },
      { name: 'redis' },
    ),
  );
  await app.register((await import('../../src/plugins/auth.js')).default);
  await app.register((await import('../../src/plugins/permissions.js')).default);
  for (const mod of [
    '../../src/routes/assets.routes.js',
    '../../src/routes/folders.routes.js',
    '../../src/routes/scan.routes.js',
  ]) {
    await app.register((await import(mod)).default, { prefix: '/v1' });
  }
  await app.ready();
  return app;
}

/** The env the routes read, pointed at the test database. */
export function testEnv() {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://unused:unused@localhost:1/unused',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 's'.repeat(40),
    PUBLIC_URL: 'https://bigbluebam.test',
    UPLOAD_MAX_FILE_SIZE: 1024 * 1024,
    PRESIGN_PUT_TTL_SECONDS: 900,
    PRESIGN_GET_TTL_SECONDS: 900,
    BIN_ALLOW_UNSCANNED_ACCESS: false,
    BBB_PERMISSIONS_ENFORCE: 'off',
    BBB_API_INTERNAL_URL: 'http://api:4000',
    INTERNAL_SERVICE_SECRET: 'i'.repeat(40),
  };
}

interface Stored {
  body: Buffer;
  contentType: string;
}

/** An in-memory StorageDriver with the methods bin-api's asset service calls. */
export function memoryDriver() {
  const objects = new Map<string, Stored>();
  const stat = async (key: string) => {
    const o = objects.get(key);
    if (!o) return null;
    return {
      size: o.body.length,
      contentType: o.contentType,
      integrity: `sha256-${createHash('sha256').update(o.body).digest('base64')}`,
    };
  };
  return {
    objects,
    driver: {
      async put(key: string, body: Buffer, opts: { contentType?: string } = {}) {
        objects.set(key, { body: Buffer.from(body), contentType: opts.contentType ?? 'application/octet-stream' });
      },
      stat,
      async getStream(key: string) {
        const o = objects.get(key);
        if (!o) throw new Error(`no object ${key}`);
        return { stream: Readable.from([o.body]), contentType: o.contentType, size: o.body.length };
      },
      async getRange(key: string, start: number, end: number) {
        const o = objects.get(key);
        if (!o) throw new Error(`no object ${key}`);
        const slice = o.body.subarray(start, end + 1);
        return { stream: Readable.from([slice]), contentType: o.contentType, size: slice.length };
      },
      async delete(key: string) {
        objects.delete(key);
      },
    },
  };
}

/** A multipart/form-data body with one file field, for app.inject. */
export function multipartFile(filename: string, contentType: string, body: Buffer) {
  const boundary = '----bin-test-boundary';
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, body, tail]),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}
