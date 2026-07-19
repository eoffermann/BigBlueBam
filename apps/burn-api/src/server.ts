import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { env } from './env.js';
import {
  BURN_PERMISSIONS_MODE,
  assertPermissionsEnforcement,
} from './boot/assert-permissions-enforce.js';
import { createErrorHandler, httpSystemErrorRecorder } from '@bigbluebam/logging';
import { healthCheckPlugin } from '@bigbluebam/service-health';
import { db, connection } from './db/index.js';
import redisPlugin from './plugins/redis.js';
import authPlugin from './plugins/auth.js';
import permissionsPlugin from './plugins/permissions.js';
import viewerCapsPlugin from './plugins/viewer-caps.js';
import rlsPlugin from './plugins/rls.js';
import { sql } from 'drizzle-orm';

// ── Boot assertion, FIRST, before anything binds a port or opens a pool.
// Spec 2.4 point 1 / 9.1: burn-api has no legacy requireAuth+role gate behind the
// permission plugin, and packages/permissions short-circuits in 'warn' mode without ever
// denying, so an unenforced burn-api would serve per-person compensation and firm-wide
// profitability to any member. The mode is a hardcoded invariant rather than an env var
// (issue #83: ENV_HINTS is a flat global map with no per-service override, so on Railway
// burn-api cannot be given a different value than the other 21 services). This asserts the
// invariant is still intact; the plugin asserts it again around registration.
try {
  assertPermissionsEnforcement(BURN_PERMISSIONS_MODE);
} catch (err) {
  console.error(
    `[burn-api] FATAL ${(err as Error).name}: ${(err as Error).message}`,
  );
  process.exit(1);
}

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
    serviceName: 'burn-api',
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
await fastify.register(websocket, { options: { maxPayload: 1_048_576 } });
await fastify.register(authPlugin);
await fastify.register(rlsPlugin);
await fastify.register(permissionsPlugin);
// Financial flooring (spec 2.4 point 2). Resolved once per request from a fail-closed
// dual-read; NEVER from fastify.canResolve, which is a hardcoded `return true` stub.
await fastify.register(viewerCapsPlugin);

// Health + readiness. The routes are /health and /health/ready (there is no /readyz
// anywhere in this platform). Per spec 9.1 the readiness checks cover ONLY Postgres and
// Redis, so an llm-provider / bill-api / bolt-api outage never cascades into burn "not
// ready" -- the gate is designed to fail OPEN on those, not to take the service down.
await fastify.register(healthCheckPlugin, {
  service: 'burn-api',
  checks: {
    postgres: async () => {
      await db.execute(sql`SELECT 1`);
    },
    redis: async () => {
      await fastify.redis.ping();
    },
  },
});

// Burn REST surface (spec 6.1) lands in M5, mounted under /v1.

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
  fastify.log.info(`Burn API listening on ${env.HOST}:${env.PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
