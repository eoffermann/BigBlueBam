import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import { env } from './env.js';
import { createErrorHandler, httpSystemErrorRecorder } from '@bigbluebam/logging';
import { healthCheckPlugin } from '@bigbluebam/service-health';
import { db, connection } from './db/index.js';
import helpdeskAuthPlugin from './plugins/auth.js';
import redisPlugin from './plugins/redis.js';
import csrfPlugin from './plugins/csrf.js';
import resolveTenantPlugin from './middleware/resolve-tenant.js';
import authRoutes from './routes/auth.routes.js';
import ticketRoutes from './routes/ticket.routes.js';
import agentRoutes from './routes/agent.routes.js';
import settingsRoutes from './routes/settings.routes.js';
import publicTenantRoutes from './routes/public-tenant.routes.js';
import helpdeskUploadRoutes from './routes/upload.routes.js';
import attachmentRoutes from './routes/attachments.routes.js';
import helpdeskUsersRoutes from './routes/users.routes.js';
// §4 Wave 5 phrase-count analytics
import analyticsRoutes from './routes/analytics.routes.js';
// §7 Wave 5 dedupe
import dedupeRoutes from './routes/dedupe.routes.js';
import websocketHandler from './ws/handler.js';
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

// Error handler
// Wire 5xxs into the platform-wide system_errors table via the api's
// internal endpoint so they show up in the SuperUser Log Analysis tab.
fastify.setErrorHandler(
  createErrorHandler({
    serviceName: 'helpdesk-api',
    recordError: env.INTERNAL_SERVICE_SECRET
      ? httpSystemErrorRecorder({
          url: `${env.BBB_API_INTERNAL_URL.replace(/\/+$/, '')}/internal/system-errors/record`,
          internalSecret: env.INTERNAL_SERVICE_SECRET,
        })
      : undefined,
  }),
);

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

// G6: register @fastify/multipart at the root so both upload.routes.ts
// and attachments.routes.ts share it. Using a generous root ceiling of
// 25 MB; per-route limits (10 MB for ticket attachments) are enforced in
// the route handlers themselves.
await fastify.register(multipart, {
  limits: {
    fileSize: 26214400,
  },
});

// Redis plugin — used by HB-57 lockout and health checks.
await fastify.register(redisPlugin);

// HB-52: CSRF protection — must run BEFORE routes.
await fastify.register(csrfPlugin);

// D-010: Tenant resolution from X-Org-Slug / X-Project-Slug headers.
// Must run BEFORE routes so request.tenantContext is populated for every
// preHandler that consults it. Registered after CSRF so the tenant hook
// never fires on requests that CSRF has already rejected.
await fastify.register(resolveTenantPlugin);

// Auth plugin
await fastify.register(helpdeskAuthPlugin);

// Health + readiness probes (shared plugin)
// Note: nginx rewrites `/helpdesk/api/*` -> `/helpdesk/*` on the upstream, so
// external `/helpdesk/api/health` hits us at `/helpdesk/health`. Register the
// shared plugin (covers /health, /health/ready, /metrics) and keep the legacy
// /helpdesk/health alias for proxied requests.
await fastify.register(healthCheckPlugin, {
  service: 'helpdesk-api',
  checks: {
    database: async () => { await db.execute(sql`SELECT 1`); },
    redis: async () => { await fastify.redis.ping(); },
  },
});
fastify.get('/helpdesk/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() };
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
await fastify.register(publicTenantRoutes);
await fastify.register(helpdeskUploadRoutes);
// G6: ticket-scoped attachments. Shares the @fastify/multipart plugin
// registered inside upload.routes.ts.
await fastify.register(attachmentRoutes);
// §14 Wave 4: idempotent helpdesk_users upsert for webhook intake flows.
await fastify.register(helpdeskUsersRoutes);
// §4 Wave 5: time-bucketed phrase-count analytics for tickets.
await fastify.register(analyticsRoutes);
// §7 Wave 5 dedupe
await fastify.register(dedupeRoutes);
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
