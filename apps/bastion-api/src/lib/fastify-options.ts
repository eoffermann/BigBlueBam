import { randomUUID } from 'node:crypto';
import type { FastifyServerOptions } from 'fastify';
import { resolveTrustProxy } from './trust-proxy.js';

export interface FastifyOptionsEnv {
  LOG_LEVEL: string;
  NODE_ENV: string;
  BASTION_TRUST_PROXY_HOPS: number;
}

/**
 * The Fastify constructor options for bastion-api. Kept separate from server.ts (which opens
 * pools and listens at import time) so the trustProxy wiring is unit-testable.
 */
export function buildFastifyOptions(env: FastifyOptionsEnv): FastifyServerOptions {
  return {
    logger: {
      level: env.LOG_LEVEL,
      transport:
        env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
    genReqId: () => randomUUID(),
    trustProxy: resolveTrustProxy(env.BASTION_TRUST_PROXY_HOPS),
  };
}
