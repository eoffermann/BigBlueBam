import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { env } from './env.js';
import { createErrorHandler } from '@bigbluebam/logging';
import { healthCheckPlugin } from '@bigbluebam/service-health';
import { db, connection } from './db/index.js';
import redisPlugin from './plugins/redis.js';
import authPlugin from './plugins/auth.js';
import { sql } from 'drizzle-orm';
import { flushAllPendingYjsWrites } from './services/yjs-persistence.service.js';

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
fastify.setErrorHandler(createErrorHandler({ serviceName: 'brief-api' }));

// Not found handler
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

await fastify.register(websocket, {
  options: {
    maxPayload: 2_097_152, // 2 MB (Yjs updates are compact binary)
  },
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

// Health + readiness probes (shared plugin)
await fastify.register(healthCheckPlugin, {
  service: 'brief-api',
  checks: {
    database: async () => { await db.execute(sql`SELECT 1`); },
    redis: async () => { await fastify.redis.ping(); },
  },
});

// Routes
import documentRoutes from './routes/document.routes.js';
import folderRoutes from './routes/folder.routes.js';
import versionRoutes from './routes/version.routes.js';
import commentRoutes from './routes/comment.routes.js';
import embedRoutes from './routes/embed.routes.js';
import templateRoutes from './routes/template.routes.js';
import linkRoutes from './routes/link.routes.js';
import collaboratorRoutes from './routes/collaborator.routes.js';
import exportRoutes from './routes/export.routes.js';
import internalRoutes from './routes/internal.routes.js';
import websocketHandler from './ws/handler.js';

await fastify.register(documentRoutes, { prefix: '/v1' });
await fastify.register(folderRoutes, { prefix: '/v1' });
await fastify.register(versionRoutes, { prefix: '/v1' });
await fastify.register(commentRoutes, { prefix: '/v1' });
await fastify.register(embedRoutes, { prefix: '/v1' });
await fastify.register(templateRoutes, { prefix: '/v1' });
await fastify.register(linkRoutes, { prefix: '/v1' });
await fastify.register(collaboratorRoutes, { prefix: '/v1' });
await fastify.register(exportRoutes, { prefix: '/v1' });
// D-12: cross-app can-read preflight for the Bureau summon system.
await fastify.register(internalRoutes, { prefix: '/v1' });

// WebSocket handler for Yjs real-time collaboration
await fastify.register(websocketHandler);

// Graceful shutdown
const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
for (const signal of signals) {
  process.on(signal, async () => {
    fastify.log.info(`Received ${signal}, shutting down gracefully...`);
    await flushAllPendingYjsWrites();
    await fastify.close();
    await connection.end();
    process.exit(0);
  });
}

// Start server
try {
  await fastify.listen({ port: env.PORT, host: env.HOST });
  fastify.log.info(`Brief API listening on ${env.HOST}:${env.PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
