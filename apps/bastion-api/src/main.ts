// bastion-api body. Loaded by server.ts AFTER its first progress line, because static ESM
// imports (env validation, pool creation) run before any statement in this file.
import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import { sql } from 'drizzle-orm';
import { createErrorHandler, httpSystemErrorRecorder } from '@bigbluebam/logging';
import { healthCheckPlugin } from '@bigbluebam/service-health';
import { env } from './env.js';
import {
  BASTION_PERMISSIONS_MODE,
  BASTION_PERMISSIONS_ON_UNKNOWN,
  assertPermissionsEnforcement,
} from './boot/assert-permissions-enforce.js';
import { assertRlsBound } from './boot/assert-rls-bound.js';
import { runBucketCheck } from './boot/bucket-check.js';
import { buildFastifyOptions } from './lib/fastify-options.js';
import { createBastionStorage } from './lib/storage.js';
import { db, allConnections } from './db/index.js';
import redisPlugin from './plugins/redis.js';
import authPlugin from './plugins/auth.js';
import permissionsPlugin from './plugins/permissions.js';
import rlsPlugin from './plugins/rls.js';
import frameworkRoutes from './routes/frameworks.routes.js';
import controlRoutes from './routes/controls.routes.js';
import setupRoutes from './routes/setup.routes.js';
import evidenceRoutes from './routes/evidence.routes.js';
import internalRoutes from './routes/internal.routes.js';
import manualEvidenceRoutes from './routes/manual-evidence.routes.js';
import feedRoutes from './routes/feeds.routes.js';
import feedIngestRoutes from './routes/feed-ingest.routes.js';
import coverageRoutes from './routes/coverage.routes.js';
import decisionRoutes from './routes/decisions.routes.js';
import { engineDeps } from './engine/runtime.js';
import { checkLedgerIdentity } from './engine/restore.js';
import { closeBastionQueues } from './lib/queue.js';

const bootStarted = Date.now();
const elapsed = () => `${((Date.now() - bootStarted) / 1000).toFixed(1)}s`;

// Permission enforcement is a hardcoded invariant, asserted before anything binds a port.
try {
  assertPermissionsEnforcement(BASTION_PERMISSIONS_MODE, BASTION_PERMISSIONS_ON_UNKNOWN);
} catch (err) {
  console.error(`[bastion-api] FATAL ${(err as Error).name}: ${(err as Error).message}`);
  process.exit(1);
}

const fastify = Fastify(buildFastifyOptions(env));

fastify.setErrorHandler(
  createErrorHandler({
    serviceName: 'bastion-api',
    recordError: env.INTERNAL_SERVICE_SECRET
      ? httpSystemErrorRecorder({
          url: `${env.BBB_API_INTERNAL_URL.replace(/\/+$/, '')}/internal/system-errors/record`,
          internalSecret: env.INTERNAL_SERVICE_SECRET,
        })
      : undefined,
  }),
);

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

// Keyed on request.ip, which honours BASTION_TRUST_PROXY_HOPS (spec 5.2).
await fastify.register(rateLimit, {
  max: env.RATE_LIMIT_MAX,
  timeWindow: env.RATE_LIMIT_WINDOW_MS,
});

fastify.addHook('onSend', async (_req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Cache-Control', 'no-store');
});

fastify.log.info(`[${elapsed()}] connecting to Redis...`);
await fastify.register(redisPlugin);
await fastify.register(authPlugin);
await fastify.register(rlsPlugin);
await fastify.register(permissionsPlugin);

// Exactly /health, /health/ready and /metrics. Readiness is Postgres and Redis ONLY (spec 9.5):
// a MinIO, LLM or bolt-api outage must never take Bastion out of rotation.
await fastify.register(healthCheckPlugin, {
  service: 'bastion-api',
  checks: {
    postgres: async () => {
      await db.execute(sql`SELECT 1`);
    },
    redis: async () => {
      await fastify.redis.ping();
    },
  },
});

// Bastion REST surface, mounted under /v1. Each milestone registers its route files here, each
// with its own requireCan gates. M3: library, frameworks, controls, assertions, setup.
// M4: evaluations, evidence, ledger seals and restores, and the internal engines/events routes.
await fastify.register(
  async (v1) => {
    await v1.register(frameworkRoutes);
    await v1.register(controlRoutes);
    await v1.register(setupRoutes);
    await v1.register(evidenceRoutes);
    // M5: manual evidence and personal data, feeds (and the machine push), coverage and summary.
    await v1.register(manualEvidenceRoutes);
    await v1.register(feedRoutes);
    await v1.register(feedIngestRoutes);
    await v1.register(coverageRoutes);
    // M6: gaps, fix drafts, exceptions and drift (both decide routes are session-only).
    await v1.register(decisionRoutes);
    await v1.register(internalRoutes);
  },
  { prefix: '/v1' },
);

// Graceful shutdown. compose gives 75 s (stop_grace_period) so a later in-flight LLM call can
// finish (spec 7.3); Railway uses RAILWAY_DEPLOYMENT_DRAINING_SECONDS=75.
let shuttingDown = false;
const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM'];
for (const signal of signals) {
  process.on(signal, async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    fastify.log.info(`Received ${signal}, draining and shutting down...`);
    try {
      // fastify.close() lets in-flight requests finish: an evaluation slice is bounded at about
      // 28 s and compose allows 75 s (stop_grace_period), so a slice is never cut mid-write; the
      // claim stays with the worker's claimant, which re-drives the run on its next poll.
      await fastify.close();
      await closeBastionQueues();
      for (const c of allConnections()) await c.end();
    } finally {
      process.exit(0);
    }
  });
}

fastify.log.info(`[${elapsed()}] checking database role posture...`);
await assertRlsBound(fastify.log);

try {
  await fastify.listen({ port: env.PORT, host: env.HOST });
  fastify.log.info(
    { trust_proxy_hops: env.BASTION_TRUST_PROXY_HOPS },
    `[${elapsed()}] Bastion API listening on ${env.HOST}:${env.PORT}`,
  );
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}

// Own-bucket check AFTER listen and not awaited: it never delays health or readiness.
void runBucketCheck(createBastionStorage(env), env.BASTION_S3_BUCKET, fastify.log);

// Restore detection at boot (spec 3.4): compare every org's ledger with its highest bucket seal.
// Not awaited; a mismatch opens a restore row and blocks appends for that org only.
void (async () => {
  try {
    const deps = engineDeps(fastify.log, fastify.redis);
    if (!deps.storage) return;
    const orgs = await deps.sql`SELECT DISTINCT organization_id FROM bastion_ledger_entries`;
    fastify.log.info(`[${elapsed()}] checking ${orgs.length} evidence ledgers against their bucket seals...`);
    for (const [i, o] of orgs.entries()) {
      const r = await checkLedgerIdentity(deps, o.organization_id as string);
      if (r.blockedBy) fastify.log.warn({ organization_id: o.organization_id, restore_id: r.blockedBy }, 'ledger appends are blocked by a detected restore');
      fastify.log.info(`[${elapsed()}] ledger identity checked ${i + 1}/${orgs.length}`);
    }
  } catch (err) {
    fastify.log.warn({ err: (err as Error).message }, 'boot ledger identity check did not finish; the next append batch repeats it');
  }
})();
