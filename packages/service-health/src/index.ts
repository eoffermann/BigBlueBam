/**
 * Shared health and readiness probe plugin for BigBlueBam Fastify services.
 *
 * Registers three routes:
 *   - GET /health       always 200 (process is up)
 *   - GET /health/ready readiness probe, checks configured dependencies
 *   - GET /metrics      basic process metrics (uptime, memory, pid)
 *
 * Dependencies are checked with a configurable per-check timeout (default 5s).
 * A single failing check degrades readiness to 503.
 */

import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';

// The one guard for server-to-server routes (#252). Lives here because every Fastify service
// already depends on (and builds) this package.
export * from './internal-secret.js';

export interface HealthCheckFn {
  (): Promise<void> | void;
}

export interface HealthCheckPluginOptions {
  service: string;
  version?: string;
  readinessTimeoutMs?: number;
  checks?: Record<string, HealthCheckFn>;
}

async function runCheckWithTimeout(
  name: string,
  fn: HealthCheckFn,
  timeoutMs: number,
): Promise<'ok' | 'error'> {
  const withTimeout = new Promise<'ok'>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${name} check timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    Promise.resolve()
      .then(() => fn())
      .then(() => {
        clearTimeout(timer);
        resolve('ok');
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
  try {
    await withTimeout;
    return 'ok';
  } catch {
    return 'error';
  }
}

export const healthCheckPlugin = fp<HealthCheckPluginOptions>(
  async (fastify: FastifyInstance, options) => {
    const service = options.service ?? 'unknown';
    const version = options.version ?? '0.0.0';
    const timeoutMs = options.readinessTimeoutMs ?? 5000;
    const checks = options.checks ?? {};

    fastify.get('/health', async (_req, reply) => {
      return reply.send({ status: 'ok', service, version, timestamp: new Date().toISOString() });
    });

    fastify.get('/health/ready', async (_req, reply) => {
      const results: Record<string, 'ok' | 'error'> = {};
      await Promise.all(
        Object.entries(checks).map(async ([name, fn]) => {
          results[name] = await runCheckWithTimeout(name, fn, timeoutMs);
        }),
      );
      const allOk = Object.values(results).every((v) => v === 'ok');
      return reply.status(allOk ? 200 : 503).send({
        status: allOk ? 'ready' : 'degraded',
        service,
        version,
        checks: results,
        timestamp: new Date().toISOString(),
      });
    });

    fastify.get('/metrics', async (_req, reply) => {
      const mem = process.memoryUsage();
      return reply.send({
        service,
        version,
        uptime_seconds: process.uptime(),
        pid: process.pid,
        memory: {
          rss: mem.rss,
          heap_total: mem.heapTotal,
          heap_used: mem.heapUsed,
          external: mem.external,
        },
      });
    });
  },
  { fastify: '5.x' },
);
