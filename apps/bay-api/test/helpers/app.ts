// bay-api as server.ts wires it (cookie, auth, permissions, every /v1 route), minus the network
// edges a unit run has no use for: Redis is a recording stub (the routes only publish realtime
// hints), and the per-action permission resolver runs in 'off' mode (requireAuth and
// requireScope still apply). Callers mock ../../src/env.js before importing this.
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import fp from 'fastify-plugin';

export interface TestApp {
  app: FastifyInstance;
  published: Array<{ channel: string; message: string }>;
}

export async function buildBayApp(): Promise<TestApp> {
  const published: TestApp['published'] = [];
  const app = Fastify({ logger: false });
  await app.register(cookie, { secret: 'c'.repeat(32) });
  await app.register(
    fp(
      async (f) => {
        f.decorate('redis', {
          publish: async (channel: string, message: string) => {
            published.push({ channel, message });
            return 1;
          },
        } as never);
      },
      { name: 'redis' },
    ),
  );
  await app.register((await import('../../src/plugins/auth.js')).default);
  await app.register((await import('../../src/plugins/permissions.js')).default);
  for (const mod of [
    '../../src/routes/assets.routes.js',
    '../../src/routes/annotations.routes.js',
    '../../src/routes/decisions.routes.js',
    '../../src/routes/review-links.routes.js',
    '../../src/routes/public-review.routes.js',
  ]) {
    await app.register((await import(mod)).default, { prefix: '/v1' });
  }
  await app.ready();
  return { app, published };
}

/** The env the routes read, pointed at the test database. */
export function testEnv() {
  return {
    NODE_ENV: 'test',
    DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://unused:unused@localhost:1/unused',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 's'.repeat(40),
    PUBLIC_URL: 'https://bigbluebam.test',
    BBB_PERMISSIONS_ENFORCE: 'off',
    BBB_API_INTERNAL_URL: 'http://api:4000',
    BIN_API_INTERNAL_URL: 'http://bin-api:4016',
    INTERNAL_SERVICE_SECRET: 'i'.repeat(40),
    S3_ENDPOINT: 'http://minio:9000',
    S3_ACCESS_KEY: 'k',
    S3_SECRET_KEY: 'k',
    S3_BUCKET: 'b',
    S3_REGION: 'us-east-1',
  };
}
