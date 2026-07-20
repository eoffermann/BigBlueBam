import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { sql } from 'drizzle-orm';
import { createErrorHandler, httpSystemErrorRecorder } from '@bigbluebam/logging';
import { healthCheckPlugin } from '@bigbluebam/service-health';
import { env } from './env.js';
import {
  BURSAR_PERMISSIONS_MODE,
  BURSAR_PERMISSIONS_ON_UNKNOWN,
  assertPermissionsEnforcement,
} from './boot/assert-permissions-enforce.js';
import { assertRlsBound } from './boot/assert-rls-bound.js';
import { db, connection } from './db/index.js';
import redisPlugin from './plugins/redis.js';
import authPlugin from './plugins/auth.js';
import permissionsPlugin from './plugins/permissions.js';
import viewerCapsPlugin from './plugins/viewer-caps.js';
import rlsPlugin from './plugins/rls.js';
import vendorRoutes from './routes/vendors.routes.js';
import requestRoutes from './routes/requests.routes.js';
import settingsRoutes from './routes/settings.routes.js';
import scopeRoutes from './routes/scope.routes.js';
import offerRoutes from './routes/offers.routes.js';
import levelingRoutes from './routes/leveling.routes.js';
import awardRoutes from './routes/awards.routes.js';
import internalRoutes from './routes/internal.routes.js';

// ── Boot assertion, FIRST, before anything binds a port or opens a pool (spec 13.3).
// bursar-api, like burn-api, has no legacy requireAuth+role gate behind the permission plugin,
// and packages/permissions short-circuits in 'warn' mode without ever denying. An unenforced
// bursar-api would serve sealed rival bids, per-vendor spend, and the finding-suppression
// knobs to any member. The mode is a HARDCODED invariant, not an env var (burn issue #83:
// ENV_HINTS is a flat global map with no per-service override). onUnknown is 'deny' because
// mode 'on' is not by itself fail-closed (burn issue #89). Both are asserted here and again at
// the plugin registration site.
try {
  assertPermissionsEnforcement(BURSAR_PERMISSIONS_MODE, BURSAR_PERMISSIONS_ON_UNKNOWN);
} catch (err) {
  console.error(`[bursar-api] FATAL ${(err as Error).name}: ${(err as Error).message}`);
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

// Multipart offer ingest (spec 11 / 5.4). The per-file ceiling is MAX_DOC_BYTES, deliberately
// BELOW nginx's server-level client_max_body_size (25m); an over-limit file part is truncated and
// the upload route returns a 413 mapped to "this file is larger than 20MB". The global nginx limit
// is NOT raised for one app's worst case.
await fastify.register(multipart, {
  limits: { fileSize: env.MAX_DOC_BYTES, files: 1, fields: 10 },
});

fastify.addHook('onSend', async (_req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Cache-Control', 'no-store');
});

await fastify.register(redisPlugin);
await fastify.register(authPlugin);
await fastify.register(rlsPlugin);
await fastify.register(permissionsPlugin);
// Financial flooring (spec 5.6). Resolved once per request from a fail-closed dual-read;
// NEVER from fastify.canResolve, which is a hardcoded `return true` stub.
await fastify.register(viewerCapsPlugin);

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

// Bursar REST surface (spec 11), mounted under /v1. Each route file registers its own
// permission gates (fastify.requireCan); there is no blanket requireAuth on the prefix. M2
// lands vendors, requests, and settings; later milestones add offers, leveling, awards,
// spend, drafts, and the /internal/* + /bursar/ws surfaces.
await fastify.register(
  async (v1) => {
    await v1.register(vendorRoutes);
    await v1.register(requestRoutes);
    await v1.register(settingsRoutes);
    // M3: scope derivation + the confirmed tree, and the /internal/* engine transport
    // (run-derivation async-start + the run-reaper).
    await v1.register(scopeRoutes);
    // M4: offer ingest + deterministic parse.
    await v1.register(offerRoutes);
    // M5: the absence engine + coverage-collapse cluster (leveling, matrix, diff, totals, review).
    await v1.register(levelingRoutes);
    // M7: award + baseline freeze + immutability (the hinge to the post-award half).
    await v1.register(awardRoutes);
    await v1.register(internalRoutes);
  },
  { prefix: '/v1' },
);

const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
for (const signal of signals) {
  process.on(signal, async () => {
    fastify.log.info(`Received ${signal}, shutting down gracefully...`);
    await fastify.close();
    await connection.end();
    process.exit(0);
  });
}

// Report the EFFECTIVE RLS posture before serving a single request. Deliberately non-fatal:
// every service currently connects as a Postgres SUPERUSER (bypasses RLS), so refusing to boot
// would make bursar-api unstartable everywhere without arming anything. It logs at fatal level
// with rls_backstop: 'absent' so the posture is visible rather than assumed.
await assertRlsBound(fastify.log);

try {
  await fastify.listen({ port: env.PORT, host: env.HOST });
  fastify.log.info(`Bursar API listening on ${env.HOST}:${env.PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
