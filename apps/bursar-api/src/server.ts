import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { sql } from 'drizzle-orm';
import { createErrorHandler, httpSystemErrorRecorder } from '@bigbluebam/logging';
import { healthCheckPlugin } from '@bigbluebam/service-health';
import { env } from './env.js';
import { db, connection } from './db/index.js';
import redisPlugin from './plugins/redis.js';
import rlsPlugin from './plugins/rls.js';

const fastify = Fastify({
  logger: {
    level: env.LOG_LEVEL,
    transport:
      env.NODE_ENV === 'development'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
  },
  genReqId: () => crypto.randomUUID(),
});

fastify.setErrorHandler(
  createErrorHandler({
    serviceName: 'bursar-api',
    recordError: env.INTERNAL_SERVICE_SECRET
      ? httpSystemErrorRecorder({
          url: `${env.BBB_API_INTERNAL_URL.replace(/\/+$/, '')}/internal/system-errors/record`,
          internalSecret: env.INTERNAL_SERVICE_SECRET,
        })
      : undefined,
  }),
);

fastify.setNotFoundHandler((request, reply) => {
  return reply.status(404).send({
    error: {
      code: 'NOT_FOUND',
      message: `Route ${request.method} ${request.url} not found`,
      details: [],
      request_id: request.id,
    },
  });
});

await fastify.register(cors, {
  origin: env.CORS_ORIGIN.split(','),
  credentials: true,
});

await fastify.register(cookie, { secret: env.SESSION_SECRET });

await fastify.register(rateLimit, {
  max: env.RATE_LIMIT_MAX,
  timeWindow: env.RATE_LIMIT_WINDOW_MS,
});

fastify.addHook('onSend', async (_req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Cache-Control', 'no-store');
});

await fastify.register(redisPlugin);
await fastify.register(rlsPlugin);

// Health + readiness. The routes registered are exactly /health, /health/ready, and
// /metrics; there is no /healthz and no /readyz anywhere in this platform, and the compose
// healthcheck plus the deploy catalog both target /health.
//
// Readiness checks Postgres and Redis ONLY (spec 18.7). It deliberately does NOT probe the
// llm-provider, braid-api, or bolt-api: those are request-time soft dependencies that the
// engines are designed to degrade around, so an upstream outage must never cascade into
// "bursar not ready" and take the container out of rotation.
await fastify.register(healthCheckPlugin, {
  service: 'bursar-api',
  checks: {
    postgres: async () => {
      await db.execute(sql`SELECT 1`);
    },
    redis: async () => {
      await fastify.redis.ping();
    },
  },
});

// M0 SCAFFOLD. The /v1 REST surface (spec 11), the /bursar/ws hub (spec 11.1), the auth and
// permission plugins, and the internal routes all land in M2 onward. What exists here is
// deliberately the minimum that boots, holds a database and Redis connection, and answers
// the healthcheck, so that the nginx /bursar/ blocks have a resolvable upstream to point at.
// The ordering matters: nginx resolves literal upstream hostnames at CONFIG LOAD time and
// the compose-mounted config has no `resolver` directive, so adding those blocks before this
// container exists takes the whole suite's frontend down.

const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
for (const signal of signals) {
  process.on(signal, async () => {
    fastify.log.info(`Received ${signal}, shutting down gracefully...`);
    await fastify.close();
    await connection.end();
    process.exit(0);
  });
}

try {
  await fastify.listen({ port: env.PORT, host: env.HOST });
  fastify.log.info(`Bursar API listening on ${env.HOST}:${env.PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
