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
import presenceRoutes from './routes/presence.routes.js';
import linkPreviewRoutes from './routes/link-preview.routes.js';
// §13 Wave 4 scheduled banter
import scheduledMessagesRoutes from './routes/scheduled-messages.routes.js';
// §1 Wave 5 banter subs
import agentSubscriptionsRoutes from './routes/agent-subscriptions.routes.js';
// Slack workspace import (docs/plans/slack-import-design.md)
import slackImportRoutes from './routes/slack-import.routes.js';
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
    serviceName: 'banter-api',
    recordError: env.INTERNAL_SERVICE_SECRET
      ? httpSystemErrorRecorder({
          url: `${env.BBB_API_INTERNAL_URL.replace(/\/+$/, '')}/internal/system-errors/record`,
          internalSecret: env.INTERNAL_SERVICE_SECRET,
        })
      : undefined,
  }),
);

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

// Per-action permissions plugin (Wave D Phase 3)
import permissionsPlugin from './plugins/permissions.js';
await fastify.register(permissionsPlugin);

// Health + readiness probes (shared plugin)
await fastify.register(healthCheckPlugin, {
  service: 'banter-api',
  checks: {
    database: async () => { await db.execute(sql`SELECT 1`); },
    redis: async () => { await fastify.redis.ping(); },
  },
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
await fastify.register(presenceRoutes);
await fastify.register(linkPreviewRoutes);
// §13 Wave 4 scheduled banter
await fastify.register(scheduledMessagesRoutes);
// §1 Wave 5 banter subs
await fastify.register(agentSubscriptionsRoutes);
// Slack workspace import (docs/plans/slack-import-design.md)
await fastify.register(slackImportRoutes);

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
