// LLM fairness: leased permits (spec 7.3), copied from admitLlmCall in
// apps/api/src/routes/internal-llm.routes.ts. Two Redis sorted sets of random tokens scored by
// admit time: `bastion:llm:svc` (3 at once across bastion-api) and `bastion:llm:org:<org>` (1 per
// org). On every admit, tokens older than the hold window (90 s, above BASTION_LLM_TIMEOUT_MS) are
// purged, so a crashed caller cannot hold a slot; the caller releases (ZREM) in `finally`.
//
// Fails OPEN when Redis is down, as the proxy does: a Redis outage must never stop a compile, and
// the proxy's own per-service cap still applies behind this one.
//
// Throughput (spec 7.3): at roughly 10-20 s per call, 3 service-wide permits give about 9-18 calls
// a minute and one org about 3-6, so a 400-call compile takes 1-2 hours.

import { randomUUID } from 'node:crypto';

export const LLM_PERMIT_HOLD_MS = 90_000;
export const LLM_PERMITS_SERVICE = 3;
export const LLM_PERMITS_PER_ORG = 1;

/** The ioredis subset the permits use (a fake in the unit tests). */
export interface PermitRedis {
  zremrangebyscore(key: string, min: number | string, max: number | string): Promise<unknown>;
  zadd(key: string, score: number, member: string): Promise<unknown>;
  zcard(key: string): Promise<number>;
  zrem(key: string, member: string): Promise<unknown>;
  pexpire(key: string, ms: number): Promise<unknown>;
}

export interface PermitLog {
  warn(obj: object, msg?: string): void;
}

export type Admission = { admitted: true; failOpen: boolean; release: () => Promise<void> } | { admitted: false };

export interface LlmPermits {
  /** Try once to take one service permit and one org permit. Never throws. */
  tryAdmit(orgId: string): Promise<Admission>;
}

export const SERVICE_KEY = 'bastion:llm:svc';
export const orgKey = (orgId: string) => `bastion:llm:org:${orgId}`;

export function createLlmPermits(
  redis: PermitRedis | null,
  opts: { now?: () => number; log?: PermitLog; serviceLimit?: number; orgLimit?: number; holdMs?: number } = {},
): LlmPermits {
  const now = opts.now ?? (() => Date.now());
  const hold = opts.holdMs ?? LLM_PERMIT_HOLD_MS;
  const svcLimit = opts.serviceLimit ?? LLM_PERMITS_SERVICE;
  const perOrg = opts.orgLimit ?? LLM_PERMITS_PER_ORG;
  const open: Admission = { admitted: true, failOpen: true, release: async () => {} };

  async function take(key: string, limit: number, token: string): Promise<boolean> {
    const t = now();
    await redis!.zremrangebyscore(key, 0, t - hold);
    await redis!.zadd(key, t, token);
    await redis!.pexpire(key, hold);
    const n = await redis!.zcard(key);
    if (n > limit) {
      await redis!.zrem(key, token).catch(() => undefined);
      return false;
    }
    return true;
  }

  return {
    async tryAdmit(orgId: string): Promise<Admission> {
      if (!redis) return open;
      const token = randomUUID();
      const okey = orgKey(orgId);
      try {
        if (!(await take(SERVICE_KEY, svcLimit, token))) return { admitted: false };
        if (!(await take(okey, perOrg, token))) {
          await redis.zrem(SERVICE_KEY, token).catch(() => undefined);
          return { admitted: false };
        }
      } catch (err) {
        opts.log?.warn({ err: (err as Error).message }, 'bastion-llm: permit check failed; admitting (fail-open)');
        await redis.zrem(SERVICE_KEY, token).catch(() => undefined);
        await redis.zrem(okey, token).catch(() => undefined);
        return open;
      }
      return {
        admitted: true,
        failOpen: false,
        release: async () => {
          await redis.zrem(SERVICE_KEY, token).catch(() => undefined);
          await redis.zrem(okey, token).catch(() => undefined);
        },
      };
    },
  };
}
