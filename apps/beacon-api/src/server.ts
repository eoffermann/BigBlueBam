import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { env } from './env.js';
import { createErrorHandler } from '@bigbluebam/logging';
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
fastify.setErrorHandler(createErrorHandler({ serviceName: 'beacon-api' }));

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
  service: 'beacon-api',
  checks: {
    database: async () => { await db.execute(sql`SELECT 1`); },
    redis: async () => { await fastify.redis.ping(); },
  },
});

// Routes
import beaconRoutes from './routes/beacon.routes.js';
import versionRoutes from './routes/version.routes.js';
import tagRoutes from './routes/tag.routes.js';
import linkRoutes from './routes/link.routes.js';
import policyRoutes from './routes/policy.routes.js';
import searchRoutes from './routes/search.routes.js';
import graphRoutes from './routes/graph.routes.js';
import commentsRoutes from './routes/comments.routes.js';
import attachmentsRoutes from './routes/attachments.routes.js';

await fastify.register(beaconRoutes, { prefix: '/v1' });
await fastify.register(versionRoutes, { prefix: '/v1' });
await fastify.register(tagRoutes, { prefix: '/v1' });
await fastify.register(linkRoutes, { prefix: '/v1' });
await fastify.register(policyRoutes, { prefix: '/v1' });
await fastify.register(searchRoutes, { prefix: '/v1' });
await fastify.register(graphRoutes, { prefix: '/v1' });
await fastify.register(commentsRoutes, { prefix: '/v1' });
await fastify.register(attachmentsRoutes, { prefix: '/v1' });

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
  fastify.log.info(`Beacon API listening on ${env.HOST}:${env.PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
