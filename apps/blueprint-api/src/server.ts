import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { sql } from 'drizzle-orm';
import { env } from './env.js';
import { createErrorHandler } from '@bigbluebam/logging';
import { healthCheckPlugin } from '@bigbluebam/service-health';
import { db, connection } from './db/index.js';
import redisPlugin from './plugins/redis.js';
import authPlugin from './plugins/auth.js';
import permissionsPlugin from './plugins/permissions.js';
import diagramRoutes from './routes/diagrams.routes.js';
import nodeRoutes from './routes/nodes.routes.js';
import edgeRoutes from './routes/edges.routes.js';
import templateRoutes from './routes/templates.routes.js';
import crossProductRoutes from './routes/cross-product.routes.js';

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

fastify.setErrorHandler(createErrorHandler({ serviceName: 'blueprint-api' }));

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
await fastify.register(authPlugin);
await fastify.register(permissionsPlugin);

await fastify.register(healthCheckPlugin, {
  service: 'blueprint-api',
  checks: {
    database: async () => {
      await db.execute(sql`SELECT 1`);
    },
    redis: async () => {
      await fastify.redis.ping();
    },
  },
});

await fastify.register(diagramRoutes, { prefix: '/v1' });
await fastify.register(nodeRoutes, { prefix: '/v1' });
await fastify.register(edgeRoutes, { prefix: '/v1' });
await fastify.register(templateRoutes, { prefix: '/v1' });
await fastify.register(crossProductRoutes, { prefix: '/v1' });

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
  fastify.log.info(`Blueprint API listening on ${env.HOST}:${env.PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
