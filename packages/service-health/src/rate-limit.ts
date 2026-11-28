/**
 * The one global rate-limit registration every Fastify service uses (#411).
 *
 * Before this, each service registered @fastify/rate-limit by hand and only api and helpdesk-api
 * honoured the e2e relaxation, so a parallel Playwright run tripped the 100/min ceiling on every
 * other service (bastion-api was where it surfaced). The relaxation rule now lives here once:
 *
 *   - BBB_E2E_PERMISSIVE_RATE_LIMIT set to a true value, OR NODE_ENV !== 'production', multiplies
 *     the global ceiling by RATE_LIMIT_E2E_MULTIPLIER (default 100).
 *   - Production stays strict unless the flag is set explicitly on that container.
 *   - Per-route limits (`config.rateLimit` on a route) are untouched: they override the plugin
 *     defaults whatever the global ceiling is.
 *
 * scripts/lib/rate-limit-single-registration.test.mjs fails CI if a service imports
 * @fastify/rate-limit directly instead of calling registerGlobalRateLimit.
 */

import rateLimit, { type RateLimitPluginOptions } from '@fastify/rate-limit';
import { envFlag } from '@bigbluebam/shared';
import type { FastifyInstance } from 'fastify';

export const DEFAULT_RATE_LIMIT_E2E_MULTIPLIER = 100;

export interface GlobalRateLimitOptions {
  /** Base ceiling per window (the service's RATE_LIMIT_MAX). */
  max: number;
  /** Window length in ms (the service's RATE_LIMIT_WINDOW_MS). */
  timeWindow: number;
  /** The service's NODE_ENV. Anything other than 'production' is permissive. */
  nodeEnv: string | undefined;
  /** Where BBB_E2E_PERMISSIVE_RATE_LIMIT and RATE_LIMIT_E2E_MULTIPLIER are read. Defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Extra @fastify/rate-limit options (keyGenerator, allowList, ...). max/timeWindow are owned here. */
  extra?: Omit<RateLimitPluginOptions, 'max' | 'timeWindow'>;
}

export interface ResolvedGlobalRateLimit {
  max: number;
  baseMax: number;
  timeWindow: number;
  permissive: boolean;
  explicitFlag: boolean;
  multiplier: number;
}

/** Parses RATE_LIMIT_E2E_MULTIPLIER: unset or '' means the default; anything else must be a positive integer. */
export function parseRateLimitMultiplier(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_RATE_LIMIT_E2E_MULTIPLIER;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`RATE_LIMIT_E2E_MULTIPLIER=${JSON.stringify(raw)} must be a positive integer`);
  }
  return n;
}

/** Works out the effective global ceiling. Pure, so it is unit-tested without a server. */
export function resolveGlobalRateLimit(opts: GlobalRateLimitOptions): ResolvedGlobalRateLimit {
  const source = opts.env ?? process.env;
  const explicitFlag = envFlag('BBB_E2E_PERMISSIVE_RATE_LIMIT', source, false);
  const multiplier = parseRateLimitMultiplier(source.RATE_LIMIT_E2E_MULTIPLIER);
  const permissive = explicitFlag || opts.nodeEnv !== 'production';
  return {
    max: permissive ? opts.max * multiplier : opts.max,
    baseMax: opts.max,
    timeWindow: opts.timeWindow,
    permissive,
    explicitFlag,
    multiplier,
  };
}

/** Registers @fastify/rate-limit globally with the shared e2e relaxation rule. Call once per service. */
export async function registerGlobalRateLimit(
  fastify: FastifyInstance,
  opts: GlobalRateLimitOptions,
): Promise<ResolvedGlobalRateLimit> {
  const resolved = resolveGlobalRateLimit(opts);
  if (resolved.permissive) {
    fastify.log.warn(
      {
        base_max: resolved.baseMax,
        effective_max: resolved.max,
        multiplier: resolved.multiplier,
        window_ms: resolved.timeWindow,
        node_env: opts.nodeEnv,
        explicit_flag: resolved.explicitFlag,
      },
      'permissive rate limit active: global ceiling raised for tests',
    );
  }
  await fastify.register(rateLimit, {
    ...opts.extra,
    max: resolved.max,
    timeWindow: resolved.timeWindow,
  });
  return resolved;
}
