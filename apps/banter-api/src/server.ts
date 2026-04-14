import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { env } from './env.js';
import { db, connection } from './db/index.js';
import redisPlugin from './plugins/redis.js';
import authPlugin from './plugins/auth.js';
import { setRedisPublisher } from './services/realtime.js';
import websocketHandler from './ws/handler.js';
import channelRoutes from './routes/channel.routes.js';
import dmRoutes from './routes/dm.routes.js';
import messageRoutes from './routes/message.routes.js';
import threadRoutes from './routes/thread.routes.js';
import reactionRoutes from './routes/reaction.routes.js';
import pinRoutes from './routes/pin.routes.js';
import bookmarkRoutes from './routes/bookmark.routes.js';
import preferenceRoutes from './routes/preference.routes.js';
import fileRoutes from './routes/file.routes.js';
import adminRoutes from './routes/admin.routes.js';
import userGroupRoutes from './routes/user-group.routes.js';
import userRoutes from './routes/user.routes.js';
import searchRoutes from './routes/search.routes.js';
import callRoutes from './routes/call.routes.js';
import webhookRoutes from './routes/webhook.routes.js';
import internalRoutes from './routes/internal.routes.js';
import { errorHandler } from './middleware/error-handler.js';
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

// Error handler (Wave 1.D: shared implementation in @bigbluebam/logging)
fastify.setErrorHandler(errorHandler);

// Not found handler — standard error envelope for 404s
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
  options: { maxPayload: 8192 },
});

// Redis plugin
await fastify.register(redisPlugin);

// Initialize realtime publisher with the redis instance
fastify.addHook('onReady', async () => {
  setRedisPublisher(fastify.redis);
});

// Auth plugin
await fastify.register(authPlugin);

// Health endpoints
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

fastify.get('/health/ready', async (_request, reply) => {
  const checks: Record<string, string> = {};

  // Check database
  try {
    await db.execute(sql`SELECT 1`);
    checks.database = 'ok';
  } catch {
    checks.database = 'error';
  }

  // Check Redis
  try {
    await fastify.redis.ping();
    checks.redis = 'ok';
  } catch {
    checks.redis = 'error';
  }

  const allOk = Object.values(checks).every((v) => v === 'ok');
  const statusCode = allOk ? 200 : 503;

  return reply.status(statusCode).send({
    status: allOk ? 'ready' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
});

// Per-route rate limit configurations.
// @fastify/rate-limit supports per-route overrides via routeConfig.
// We register route-level hooks that add rate limits to specific endpoints.
fastify.addHook('onRoute', (routeOptions) => {
  const key = `${routeOptions.method}:${routeOptions.url}`;
  const perRouteRateLimits: Record<string, { max: number; timeWindow: string }> = {
    // POST message: 30/min per user
    'POST:/v1/channels/:id/messages': { max: 30, timeWindow: '1 minute' },
    // File upload: 10/min per user
    'POST:/v1/files/upload': { max: 10, timeWindow: '1 minute' },
    // Search: 20/min per user
    'GET:/v1/search/messages': { max: 20, timeWindow: '1 minute' },
    'GET:/v1/search/channels': { max: 20, timeWindow: '1 minute' },
    // Reaction: 60/min per user
    'POST:/v1/messages/:id/reactions': { max: 60, timeWindow: '1 minute' },
    // Channel create: 5/hr per user
    'POST:/v1/channels': { max: 5, timeWindow: '1 hour' },
    // Call start: 5/hr per user
    'POST:/v1/channels/:id/calls': { max: 5, timeWindow: '1 hour' },
  };

  const limit = perRouteRateLimits[key];
  if (limit) {
    routeOptions.config = {
      ...((routeOptions.config as Record<string, unknown>) ?? {}),
      rateLimit: {
        max: limit.max,
        timeWindow: limit.timeWindow,
        keyGenerator: (request: any) =>
          request.user?.id ?? request.ip,
      },
    };
  }
});

// Routes
await fastify.register(channelRoutes);
await fastify.register(dmRoutes);
await fastify.register(messageRoutes);
await fastify.register(threadRoutes);
await fastify.register(reactionRoutes);
await fastify.register(pinRoutes);
await fastify.register(bookmarkRoutes);
await fastify.register(preferenceRoutes);
await fastify.register(fileRoutes);
await fastify.register(adminRoutes);
await fastify.register(userGroupRoutes);
await fastify.register(userRoutes);
await fastify.register(searchRoutes);
await fastify.register(callRoutes);
await fastify.register(webhookRoutes);
await fastify.register(internalRoutes);

// WebSocket handler
await fastify.register(websocketHandler);

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
  fastify.log.info(`Banter API listening on ${env.HOST}:${env.PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
