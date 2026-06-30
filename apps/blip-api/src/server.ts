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
  // Telemetry batches can be large; the per-route ingest cap is enforced in the
  // handler from the resolved tracked-app config, but keep a generous ceiling.
  bodyLimit: 8 * 1024 * 1024,
});

// Wire 5xxs into the platform-wide system_errors table via the api's internal
// endpoint so they show up in the SuperUser Log Analysis tab.
fastify.setErrorHandler(
  createErrorHandler({
    serviceName: 'blip-api',
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

await fastify.register(cookie, {
  secret: env.SESSION_SECRET,
});

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
await fastify.register(authPlugin);

import permissionsPlugin from './plugins/permissions.js';
await fastify.register(permissionsPlugin);

// Realtime live-tail fanout (Blip §8).
await fastify.register(websocket, { options: { maxPayload: 1024 * 1024 } });

await fastify.register(healthCheckPlugin, {
  service: 'blip-api',
  checks: {
    database: async () => {
      await db.execute(sql`SELECT 1`);
    },
    redis: async () => {
      await fastify.redis.ping();
    },
  },
});

// Public ingest surface (no session auth; the ingest key is the credential).
// nginx maps /blip/ingest/ -> blip-api:4018/ingest/, so this serves /ingest/v1.
import ingestRoutes from './routes/ingest.routes.js';
await fastify.register(ingestRoutes, { prefix: '/ingest' });

// Authenticated REST surface (reached via /blip/api/ -> blip-api:4018/).
import appsRoutes from './routes/apps.routes.js';
import keysRoutes from './routes/keys.routes.js';
import entriesRoutes from './routes/entries.routes.js';
import viewsRoutes from './routes/views.routes.js';
import watchesRoutes from './routes/watches.routes.js';
import transformsRoutes from './routes/transforms.routes.js';
import retentionRoutes from './routes/retention.routes.js';
import fieldsRoutes from './routes/fields.routes.js';
import capturesRoutes from './routes/captures.routes.js';
import timelapseRoutes from './routes/timelapse.routes.js';

await fastify.register(appsRoutes, { prefix: '/v1' });
await fastify.register(keysRoutes, { prefix: '/v1' });
await fastify.register(entriesRoutes, { prefix: '/v1' });
await fastify.register(viewsRoutes, { prefix: '/v1' });
await fastify.register(watchesRoutes, { prefix: '/v1' });
await fastify.register(transformsRoutes, { prefix: '/v1' });
await fastify.register(retentionRoutes, { prefix: '/v1' });
await fastify.register(fieldsRoutes, { prefix: '/v1' });
await fastify.register(capturesRoutes, { prefix: '/v1' });
await fastify.register(timelapseRoutes, { prefix: '/v1' });

// Realtime WS hub (live tail). nginx maps /blip/ws -> blip-api:4018/ws.
import wsRoutes from './routes/ws.routes.js';
await fastify.register(wsRoutes);

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
  fastify.log.info(`Blip API listening on ${env.HOST}:${env.PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
