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
});

// Error handler
// Wire 5xxs into the platform-wide system_errors table via the api's
// internal endpoint so they show up in the SuperUser Log Analysis tab.
fastify.setErrorHandler(
  createErrorHandler({
    serviceName: 'bin-api',
    recordError: env.INTERNAL_SERVICE_SECRET
      ? httpSystemErrorRecorder({
          url: `${env.BBB_API_INTERNAL_URL.replace(/\/+$/, '')}/internal/system-errors/record`,
          internalSecret: env.INTERNAL_SERVICE_SECRET,
        })
      : undefined,
  }),
);

// Not found handler — standard error envelope for unknown routes
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

// Plugins
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

// Security headers
fastify.addHook('onSend', async (_req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Cache-Control', 'no-store');
});

// Redis plugin
await fastify.register(redisPlugin);

// Auth plugin
await fastify.register(authPlugin);

// Per-action permissions plugin (Wave D Phase 3)
import permissionsPlugin from './plugins/permissions.js';
await fastify.register(permissionsPlugin);

// Realtime fanout (live structured-data edits + editor presence).
await fastify.register(websocket, { options: { maxPayload: 8192 } });

// Health + readiness probes (shared plugin)
await fastify.register(healthCheckPlugin, {
  service: 'bin-api',
  checks: {
    database: async () => { await db.execute(sql`SELECT 1`); },
    redis: async () => { await fastify.redis.ping(); },
  },
});

// Routes (authenticated)
import assetRoutes from './routes/assets.routes.js';
import folderRoutes from './routes/folders.routes.js';
import dataRoutes from './routes/data.routes.js';
import wsRoutes from './routes/ws.routes.js';

await fastify.register(assetRoutes, { prefix: '/v1' });
await fastify.register(folderRoutes, { prefix: '/v1' });
await fastify.register(dataRoutes, { prefix: '/v1' });
await fastify.register(wsRoutes);

// Graceful shutdown
const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
for (const signal of signals) {
  process.on(signal, async () => {
    fastify.log.info(`Received ${signal}, shutting down gracefully...`);
    await fastify.close();
    await connection.end();
    process.exit(0);
  });
}

// Start server
try {
  await fastify.listen({ port: env.PORT, host: env.HOST });
  fastify.log.info(`Bin API listening on ${env.HOST}:${env.PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
