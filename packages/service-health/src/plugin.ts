import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { collectDefaultMetrics, Registry } from 'prom-client';

export interface ServiceHealthChecks {
  /**
   * Readiness probe for the primary database. Should return `true` when
   * the service can serve requests that depend on the DB, `false` or
   * throw otherwise. The plugin catches thrown errors and treats them as
   * `false`.
   */
  database?: () => Promise<boolean>;
  /**
   * Readiness probe for Redis / any cache or queue backend the service
   * depends on.
   */
  redis?: () => Promise<boolean>;
}

export interface ServiceHealthOptions {
  /**
   * Short service identifier - stamped into the liveness response and the
   * prometheus metric namespace.
   */
  serviceName: string;
  /**
   * Optional readiness checks. Omitted checks are treated as a no-op that
   * always reports ready.
   */
  checks?: ServiceHealthChecks;
  /**
   * Override the URL path prefix. Defaults to `''` which means the plugin
   * registers `/health/live`, `/health/ready`, and `/metrics`.
   */
  prefix?: string;
  /**
   * Provide a pre-built prom-client registry instead of the plugin-owned
   * one. Useful when the consumer wants to attach their own counters.
   */
  registry?: Registry;
}

/**
 * Fastify plugin that exposes the canonical Bam health + metrics routes:
 *
 *   - GET /health/live  -> 200 whenever the process is running
 *   - GET /health/ready -> 200 iff every configured check resolves to true
 *   - GET /metrics      -> prom-client default metrics (plus anything the
 *                           consumer registers on the shared registry)
 */
async function serviceHealthPluginImpl(
  fastify: FastifyInstance,
  opts: ServiceHealthOptions,
): Promise<void> {
  const prefix = opts.prefix ?? '';
  const registry = opts.registry ?? new Registry();
  if (!opts.registry) {
    // Only install default metrics once against our own registry; if the
    // caller passed in their own we assume they already configured it.
    collectDefaultMetrics({
      register: registry,
      prefix: `${opts.serviceName.replace(/[^a-z0-9]/gi, '_')}_`,
    });
  }

  fastify.get(
    `${prefix}/health/live`,
    async (_request: FastifyRequest, reply: FastifyReply) => {
      return reply.status(200).send({
        status: 'ok',
        service: opts.serviceName,
        uptime_seconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      });
    },
  );

  fastify.get(
    `${prefix}/health/ready`,
    async (_request: FastifyRequest, reply: FastifyReply) => {
      const results: Record<string, { ok: boolean; error?: string }> = {};
      const checks = opts.checks ?? {};
      let allOk = true;

      for (const [name, check] of Object.entries(checks)) {
        if (!check) continue;
        try {
          const ok = await check();
          results[name] = { ok };
          if (!ok) allOk = false;
        } catch (err) {
          results[name] = {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
          allOk = false;
        }
      }

      return reply.status(allOk ? 200 : 503).send({
        status: allOk ? 'ready' : 'not_ready',
        service: opts.serviceName,
        checks: results,
        timestamp: new Date().toISOString(),
      });
    },
  );

  fastify.get(
    `${prefix}/metrics`,
    async (_request: FastifyRequest, reply: FastifyReply) => {
      reply.header('Content-Type', registry.contentType);
      return reply.send(await registry.metrics());
    },
  );
}

export const serviceHealthPlugin = fp(serviceHealthPluginImpl, {
  name: '@bigbluebam/service-health',
  fastify: '5.x',
});
