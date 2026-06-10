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
fastify.setErrorHandler(createErrorHandler({ serviceName: 'bureau-api' }));

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
  options: {
    maxPayload: 5_242_880, // 5 MB
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

// Health + readiness probes (shared plugin)
await fastify.register(healthCheckPlugin, {
  service: 'bureau-api',
  checks: {
    database: async () => { await db.execute(sql`SELECT 1`); },
    redis: async () => { await fastify.redis.ping(); },
  },
});

// ─────────────────────────────────────────────────────────────────────
// TODO(workstream 2): register Bureau route modules. Coming online:
//   - floors.routes.ts     — CRUD for office floors (layout + metadata)
//   - rooms.routes.ts      — CRUD for rooms within a floor
//   - offices.routes.ts    — per-user office assignments (occupants, perms)
//   - bookings.routes.ts   — room reservations (calls Book for availability)
//   - knocks.routes.ts     — async "knock" requests on an occupied office
//   - summons.routes.ts    — pull-into-room invites (calls livekit-tokens)
//   - presence.routes.ts   — heartbeat + active-room presence tracking
//   - settings.routes.ts   — per-org Bureau policy + defaults
//   - livekit.routes.ts    — mints LiveKit access tokens for room joins
// Workstream 2 will also wire a websocket handler (presence + knock fan-out)
// and the per-action permissions plugin once the bureau permission_keys land.
// ─────────────────────────────────────────────────────────────────────

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
  fastify.log.info(`Bureau API listening on ${env.HOST}:${env.PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
