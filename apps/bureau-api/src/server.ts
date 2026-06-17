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
import floorsRoutes from './routes/floors.routes.js';
import roomsRoutes from './routes/rooms.routes.js';
import settingsRoutes from './routes/settings.routes.js';
import internalRoutes from './routes/internal.routes.js';
import officesRoutes from './routes/offices.routes.js';
import bookingsRoutes from './routes/bookings.routes.js';
import knocksRoutes from './routes/knocks.routes.js';
import livekitRoutes from './routes/livekit.routes.js';
import summonsRoutes from './routes/summons.routes.js';
import presenceHereRoutes from './routes/presence-here.routes.js';
import presenceWhereRoutes from './routes/presence-where.routes.js';
import meStatusRoutes from './routes/me-status.routes.js';
import ringRoutes from './routes/ring.routes.js';
import wsRoutes from './routes/ws.routes.js';
import chatRoutes from './routes/chat.routes.js';
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
    serviceName: 'bureau-api',
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

// Agent A (workstream 2): admin surfaces — floors, rooms, ACL, door, settings.
await fastify.register(floorsRoutes, { prefix: '/v1' });
await fastify.register(roomsRoutes, { prefix: '/v1' });
await fastify.register(settingsRoutes, { prefix: '/v1' });

// Agent C (workstream 2): internal cross-app routes (X-Internal-Service-Secret).
// Hosts the can-join-room preflight that board-api / brief-api call before
// minting a LiveKit token for a `?lkRoom=bureau-room-X` summon link.
await fastify.register(internalRoutes, { prefix: '/v1' });

// Agent B (workstream 2): member surfaces — office assignment,
// bookings, knocks, and the LiveKit access-token mint for joining
// `bureau-room-{id}` rooms.
await fastify.register(officesRoutes, { prefix: '/v1' });
await fastify.register(bookingsRoutes, { prefix: '/v1' });
await fastify.register(knocksRoutes, { prefix: '/v1' });
await fastify.register(livekitRoutes, { prefix: '/v1' });

// Agent C (workstream 6): summon orchestration (plan/record/fan-out +
// §4.4 grant-access follow-up). REST mirror of the §8 summon-family
// WS messages defined in ws.routes.ts.
await fastify.register(summonsRoutes, { prefix: '/v1' });

// presence-and-immediate-interaction (Agent A, follow-up wave):
//   - presenceHereRoutes: GET /v1/presence/here?url=... — list other users
//     currently co-present on the same content surface URL.
//   - ringRoutes: POST /v1/ring — push an incoming-call overlay to a
//     specific user on a specific surface (huddle invite signal).
// Surface-scoped huddle token mint lives inside livekitRoutes above
// (POST /v1/surface-huddle/token).
await fastify.register(presenceHereRoutes, { prefix: '/v1' });
// Hunt: GET /v1/presence/where/:userId — where is this org member right
// now (url/app/label), so the caller can jump to them. Org-scoped,
// DND-respecting, destination-access-filtered.
await fastify.register(presenceWhereRoutes, { prefix: '/v1' });
// Real-presence (workstream 13): org-wide presence snapshot, point-locate,
// and the durable + live set-status path that backs the bureau_get_presence
// / bureau_locate_user / bureau_set_status MCP tools (previously stubs).
await fastify.register(meStatusRoutes, { prefix: '/v1' });
await fastify.register(ringRoutes, { prefix: '/v1' });
// Room text chat recovery + retention (live chat itself rides the WS hub).
await fastify.register(chatRoutes, { prefix: '/v1' });

// Bureau WebSocket hub — Agent B. Mounted at `/bureau/ws` (no /v1 prefix
// because nginx proxies `/bureau/ws` straight through to this endpoint).
// Handles presence, room enter/leave, door + lock, knocks, and the
// LiveKit-token handoff for spatial audio.
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
  fastify.log.info(`Bureau API listening on ${env.HOST}:${env.PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
