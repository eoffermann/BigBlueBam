import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { env } from './env.js';
import { createErrorHandler, httpSystemErrorRecorder } from '@bigbluebam/logging';
import { healthCheckPlugin } from '@bigbluebam/service-health';
import { db, connection } from './db/index.js';
import redisPlugin from './plugins/redis.js';
import authPlugin from './plugins/auth.js';
import permissionsPlugin from './plugins/permissions.js';
import rlsPlugin from './plugins/rls.js';
import contractRoutes from './routes/contracts.routes.js';
import obligationRoutes from './routes/obligations.routes.js';
import deadlineRoutes from './routes/deadlines.routes.js';
import waiverRoutes from './routes/waivers.routes.js';
import vendorTierRoutes from './routes/vendor-tiers.routes.js';
import complianceRoutes from './routes/compliance.routes.js';
import settingsRoutes from './routes/settings.routes.js';
import internalRoutes from './routes/internal.routes.js';
import websocketHandler from './ws/handler.js';
import { sql } from 'drizzle-orm';

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
    serviceName: 'bulwark-api',
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

// The /bulwark/ws realtime hub (refs-only, org-scoped rooms). Registered after the redis
// plugin so it can open its own subscriber connection (spec 5.2).
await fastify.register(websocketHandler);

// proposal.decided subscription (spec 2.2 / 5.4). TRANSPORT: Bolt is an ingest hub with no
// service fan-out, so delivery is via the internal route POST /internal/proposal-decided
// (guarded by INTERNAL_SERVICE_SECRET) that bolt-api will POST to. Nothing to "start" here
// beyond that route (registered in bulwarkRoutes in a later milestone); the handler is
// idempotent (CAS-guarded).

// Health + readiness. Per spec 5.1/9.5, /readyz checks ONLY Postgres + Redis so an
// llm-provider / bolt-api / Braid outage never cascades into bulwark "not ready."
await fastify.register(healthCheckPlugin, {
  service: 'bulwark-api',
  checks: {
    database: async () => {
      await db.execute(sql`SELECT 1`);
    },
    redis: async () => {
      await fastify.redis.ping();
    },
  },
});

// Bulwark REST surface (spec 5.1), split by resource group, all under /v1.
for (const routeGroup of [
  contractRoutes,
  obligationRoutes,
  deadlineRoutes,
  waiverRoutes,
  vendorTierRoutes,
  complianceRoutes,
  settingsRoutes,
  internalRoutes,
]) {
  await fastify.register(routeGroup, { prefix: '/v1' });
}

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
  fastify.log.info(`Bulwark API listening on ${env.HOST}:${env.PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
