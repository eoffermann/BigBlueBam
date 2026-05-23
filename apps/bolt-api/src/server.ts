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
fastify.setErrorHandler(createErrorHandler({ serviceName: 'bolt-api' }));

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

// Health + readiness probes (shared plugin)
await fastify.register(healthCheckPlugin, {
  service: 'bolt-api',
  checks: {
    database: async () => { await db.execute(sql`SELECT 1`); },
    redis: async () => { await fastify.redis.ping(); },
  },
});

// Routes
import automationRoutes from './routes/automation.routes.js';
import executionRoutes from './routes/execution.routes.js';
import eventRoutes from './routes/event.routes.js';
import templateRoutes from './routes/template.routes.js';
import aiAssistRoutes from './routes/ai-assist.routes.js';
import eventIngestionRoutes from './routes/event-ingestion.routes.js';
// §12 Wave 5 bolt observability
import observabilityRoutes from './routes/observability.routes.js';

await fastify.register(automationRoutes, { prefix: '/v1' });
await fastify.register(executionRoutes, { prefix: '/v1' });
// §12 Wave 5 bolt observability: register before eventRoutes so the literal
// path `/events/recent` and the specific `/events/:event_id/trace` shape win
// over the dynamic `/events/:source` handler in event.routes.ts.
await fastify.register(observabilityRoutes, { prefix: '/v1' });
await fastify.register(eventRoutes, { prefix: '/v1' });
await fastify.register(templateRoutes, { prefix: '/v1' });
await fastify.register(aiAssistRoutes, { prefix: '/v1' });
await fastify.register(eventIngestionRoutes, { prefix: '/v1' });

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
  fastify.log.info(`Bolt API listening on ${env.HOST}:${env.PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
