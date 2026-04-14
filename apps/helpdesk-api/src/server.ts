import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { env } from './env.js';
import { db, connection } from './db/index.js';
import helpdeskAuthPlugin from './plugins/auth.js';
import redisPlugin from './plugins/redis.js';
import csrfPlugin from './plugins/csrf.js';
import authRoutes from './routes/auth.routes.js';
import ticketRoutes from './routes/ticket.routes.js';
import agentRoutes from './routes/agent.routes.js';
import settingsRoutes from './routes/settings.routes.js';
import helpdeskUploadRoutes from './routes/upload.routes.js';
import websocketHandler from './ws/handler.js';
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
  // HB-48: request ID generated here should be forwarded in any future
  // cross-service HTTP calls via the `X-Request-ID` header. Currently moot
  // since helpdesk writes directly to Bam's DB and does not make outbound
  // service-to-service HTTP calls.
  genReqId: () => crypto.randomUUID(),
  // HB-22: prevent hung connections when DB queries stall
  requestTimeout: 30000,
});

// Error handler (Wave 1.D: shared implementation in @bigbluebam/logging)
fastify.setErrorHandler(errorHandler);

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

// BAM-RL-E2E: Loosen the global rate limit ceiling for non-production
// environments and for explicitly opted-in test/dev stacks. Route-level
// rate limits on sensitive endpoints still apply unchanged because they
// override the plugin defaults via Fastify's per-route `config.rateLimit`.
// This only relaxes the global ceiling that was throttling parallel Playwright
// workers on /auth/login. Production stays strict unless an operator explicitly
// sets BBB_E2E_PERMISSIVE_RATE_LIMIT=1, which is intentional and logged below.
const permissiveRateLimit =
  env.BBB_E2E_PERMISSIVE_RATE_LIMIT === true || env.NODE_ENV !== 'production';
const effectiveRateLimitMax = permissiveRateLimit
  ? env.RATE_LIMIT_MAX * env.RATE_LIMIT_E2E_MULTIPLIER
  : env.RATE_LIMIT_MAX;
if (permissiveRateLimit) {
  fastify.log.warn(
    {
      base_max: env.RATE_LIMIT_MAX,
      effective_max: effectiveRateLimitMax,
      multiplier: env.RATE_LIMIT_E2E_MULTIPLIER,
      window_ms: env.RATE_LIMIT_WINDOW_MS,
      node_env: env.NODE_ENV,
      explicit_flag: env.BBB_E2E_PERMISSIVE_RATE_LIMIT === true,
    },
    'permissive rate limit active — global helpdesk auth ceiling raised for tests',
  );
}
await fastify.register(rateLimit, {
  max: effectiveRateLimitMax,
  timeWindow: env.RATE_LIMIT_WINDOW_MS,
  // HB-25: prefer authenticated user id so a single customer can't bypass
  // limits by switching IPs. Falls back to IP for unauthenticated requests.
  keyGenerator: (req: any) => req.helpdeskUser?.id ?? req.ip,
});

await fastify.register(websocket);

// Redis plugin — used by HB-57 lockout and health checks.
await fastify.register(redisPlugin);

// HB-52: CSRF protection — must run BEFORE routes.
await fastify.register(csrfPlugin);

// Auth plugin
await fastify.register(helpdeskAuthPlugin);

// Health endpoints
// Note: nginx rewrites `/helpdesk/api/*` -> `/helpdesk/*` on the upstream, so
// external `/helpdesk/api/health` hits us at `/helpdesk/health`. Register both
// to support direct-container checks and proxied requests.
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});
fastify.get('/helpdesk/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

fastify.get('/health/ready', async (_request, reply) => {
  const checks: Record<string, string> = { database: 'ok', redis: 'ok' };

  try {
    await db.execute(sql`SELECT 1`);
  } catch {
    checks.database = 'fail';
  }

  try {
    await fastify.redis.ping();
  } catch {
    checks.redis = 'fail';
  }

  const allOk = Object.values(checks).every((v) => v === 'ok');
  const statusCode = allOk ? 200 : 503;

  return reply.status(statusCode).send({
    status: allOk ? 'ready' : 'degraded',
    checks,
    timestamp: new Date().toISOString(),
  });
});

// Routes
await fastify.register(authRoutes);
await fastify.register(ticketRoutes);
// HB-50 follow-up: mount agent routes under /helpdesk/agents so that after
// nginx's `/helpdesk/api/` → `/helpdesk/` rewrite they surface at
// `/helpdesk/api/agents/...` externally. Without this prefix, paths like
// `/tickets` collide with ticket.routes.ts's customer-facing `/helpdesk/tickets`
// under the same nginx rewrite and the agent routes are unreachable.
await fastify.register(agentRoutes, { prefix: '/helpdesk/agents' });
await fastify.register(settingsRoutes);
await fastify.register(helpdeskUploadRoutes);
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
  fastify.log.info(`Helpdesk API listening on ${env.HOST}:${env.PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
