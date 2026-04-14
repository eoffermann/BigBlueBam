import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { env } from './env.js';
import { db, connection } from './db/index.js';
import { errorHandler } from './middleware/error-handler.js';
import redisPlugin from './plugins/redis.js';
import csrfPlugin from './plugins/csrf.js';
import authPlugin from './plugins/auth.js';
import rlsPlugin from './plugins/rls.js';
import authRoutes from './routes/auth.routes.js';
import projectRoutes from './routes/project.routes.js';
import phaseRoutes from './routes/phase.routes.js';
import sprintRoutes from './routes/sprint.routes.js';
import taskRoutes from './routes/task.routes.js';
import commentRoutes from './routes/comment.routes.js';
import orgRoutes from './routes/org.routes.js';
import activityRoutes from './routes/activity.routes.js';
import notificationRoutes from './routes/notification.routes.js';
import labelRoutes from './routes/label.routes.js';
import taskStateRoutes from './routes/task-state.routes.js';
import epicRoutes from './routes/epic.routes.js';
import customFieldRoutes from './routes/custom-field.routes.js';
import attachmentRoutes from './routes/attachment.routes.js';
import timeEntryRoutes from './routes/time-entry.routes.js';
import reportRoutes from './routes/report.routes.js';
import exportRoutes from './routes/export.routes.js';
import webhookRoutes from './routes/webhook.routes.js';
import apiKeyRoutes from './routes/api-key.routes.js';
import importRoutes from './routes/import.routes.js';
import templateRoutes from './routes/template.routes.js';
import reactionRoutes from './routes/reaction.routes.js';
import icalRoutes from './routes/ical.routes.js';
import viewRoutes from './routes/view.routes.js';
import uploadRoutes from './routes/upload.routes.js';
import platformRoutes from './routes/platform.routes.js';
import guestRoutes from './routes/guest.routes.js';
import superuserRoutes from './routes/superuser.routes.js';
import emailVerifyRoutes from './routes/email-verify.routes.js';
import internalHelpdeskRoutes from './routes/internal-helpdesk.routes.js';
import slackWebhookRoutes from './routes/slack-webhook.routes.js';
import slackIntegrationRoutes from './routes/slack-integration.routes.js';
import githubWebhookRoutes from './routes/github-webhook.routes.js';
import githubIntegrationRoutes from './routes/github-integration.routes.js';
import publicConfigRoutes from './routes/public-config.routes.js';
import llmProviderRoutes from './routes/llm-provider.routes.js';
import systemSettingsRoutes from './routes/system-settings.routes.js';
import versionRoutes from './routes/version.routes.js';
import userRoutes from './routes/user.routes.js';
import { sql } from 'drizzle-orm';
import websocketHandlerPlugin from './plugins/websocket.js';

const fastify = Fastify({
  trustProxy: true, // BAM-009: API runs behind nginx which sets X-Forwarded-For
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
fastify.setErrorHandler(errorHandler);

// 404 handler — return the canonical error envelope for unknown routes
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
// environments and for explicitly opted-in test/dev stacks. The route-level
// rate limits on sensitive endpoints (org admin, llm-provider, change-password,
// switch-org, guest invite acceptance) still apply unchanged because they
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
    'permissive rate limit active — global /auth/login ceiling raised for tests',
  );
}
await fastify.register(rateLimit, {
  max: effectiveRateLimitMax,
  timeWindow: env.RATE_LIMIT_WINDOW_MS,
});

// BAM-026: Limit WebSocket message payload size. Subscribe/unsubscribe
// messages are tiny JSON; 4 KiB is more than sufficient.
await fastify.register(websocket, {
  options: { maxPayload: 4096 },
});

// BAM-007: Security headers on all responses
fastify.addHook('onSend', async (_req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Cache-Control', 'no-store');
});

// BAM-008: Only expose Swagger UI outside production
if (env.NODE_ENV !== 'production') {
  await fastify.register(swagger, {
    openapi: {
      info: {
        title: 'BigBlueBam API',
        version: '0.1.0',
        description: 'Project management API',
      },
      servers: [{ url: `http://localhost:${env.PORT}` }],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
  });
}

// Redis plugin
await fastify.register(redisPlugin);

// HB-52: CSRF protection — must run BEFORE routes so state-changing
// endpoints reject sessions-without-token before any handler runs.
await fastify.register(csrfPlugin);

// Auth plugin
await fastify.register(authPlugin);

// Wave 1 §3.3 — RLS plugin. Installs request.withRls and toggles the DB
// role's BYPASSRLS attribute at boot based on BBB_RLS_ENFORCE.
await fastify.register(rlsPlugin);

// WebSocket handler (realtime events via Redis PubSub)
await fastify.register(websocketHandlerPlugin);

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

// Routes
await fastify.register(authRoutes);
await fastify.register(projectRoutes);
await fastify.register(phaseRoutes);
await fastify.register(sprintRoutes);
await fastify.register(taskRoutes);
await fastify.register(commentRoutes);
await fastify.register(orgRoutes);
await fastify.register(activityRoutes);
await fastify.register(notificationRoutes);
await fastify.register(labelRoutes);
await fastify.register(taskStateRoutes);
await fastify.register(epicRoutes);
await fastify.register(customFieldRoutes);
await fastify.register(attachmentRoutes);
await fastify.register(timeEntryRoutes);
await fastify.register(reportRoutes);
await fastify.register(exportRoutes);
await fastify.register(webhookRoutes);
await fastify.register(apiKeyRoutes);
await fastify.register(importRoutes);
await fastify.register(templateRoutes);
await fastify.register(reactionRoutes);
await fastify.register(icalRoutes);
await fastify.register(viewRoutes);
await fastify.register(uploadRoutes);
await fastify.register(platformRoutes);
await fastify.register(guestRoutes);
await fastify.register(superuserRoutes, { prefix: '/superuser' });
await fastify.register(emailVerifyRoutes);
await fastify.register(internalHelpdeskRoutes, { prefix: '/internal/helpdesk' });
await fastify.register(slackWebhookRoutes);
await fastify.register(slackIntegrationRoutes);
await fastify.register(githubWebhookRoutes);
await fastify.register(githubIntegrationRoutes);
await fastify.register(publicConfigRoutes);
await fastify.register(llmProviderRoutes);
await fastify.register(systemSettingsRoutes);
await fastify.register(versionRoutes);
await fastify.register(userRoutes);

// BAM-029: TODO — Add a periodic session cleanup job to the worker service.
// Expired sessions (sessions.expires_at < NOW()) accumulate in the database
// and should be reaped on a schedule (e.g. every hour via BullMQ repeatable
// job). This is an operational concern — the auth plugin already rejects
// expired sessions on each request, but the rows are never deleted.

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
  fastify.log.info(`Server listening on ${env.HOST}:${env.PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
