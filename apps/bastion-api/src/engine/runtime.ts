// Production wiring for the engines: the real pools, the Bastion bucket, Redis cursors, the
// seal signer and the HMAC key id. Built once per process.

import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { engineConnection, engineReadConnection } from '../db/index.js';
import { env } from '../env.js';
import { currentSealSigner, pdHmac, pdHmacKeyId, publishedSealKeyMap } from '../lib/keys.js';
import { createBastionStorage } from '../lib/storage.js';
import type { EngineDeps } from './context.js';
import { makeRunInOrgScopeRead } from './read-scope.js';
import type { SealCacheEntry } from './restore.js';

/**
 * Cursor compare-and-set (#256): KEYS[1] the cursor; ARGV = expected value, '1' when the cursor is
 * expected to be absent, the next value, the TTL in seconds. 1 when written, 0 when another caller
 * moved the cursor first.
 */
const CURSOR_CAS_LUA = `
local cur = redis.call('get', KEYS[1])
if ARGV[2] == '1' then
  if cur then return 0 end
elseif cur ~= ARGV[1] then
  return 0
end
redis.call('set', KEYS[1], ARGV[3], 'EX', tonumber(ARGV[4]))
return 1`;

let deps: EngineDeps | null = null;
const sealCache = new Map<string, SealCacheEntry>();

export function engineDeps(log: FastifyBaseLogger, redis: Redis): EngineDeps {
  if (deps) return deps;
  deps = {
    // The engines' own clients: never the drizzle-wrapped ones (see db/index.ts).
    sql: engineConnection,
    runRead: makeRunInOrgScopeRead({
      primary: engineConnection,
      read: engineReadConnection,
      statementTimeoutMs: env.BASTION_PROBE_TIMEOUT_MS,
    }),
    storage: createBastionStorage(env),
    log: {
      info: (o, m) => log.info(o, m),
      warn: (o, m) => log.warn(o, m),
      error: (o, m) => log.error(o, m),
    },
    now: () => new Date(),
    signer: currentSealSigner(),
    sealKeys: publishedSealKeyMap(),
    pdKeyId: pdHmacKeyId(),
    pdHmac,
    probeTimeoutMs: env.BASTION_PROBE_TIMEOUT_MS,
    putTimeoutMs: env.BASTION_PUT_TIMEOUT_MS,
    leaseMs: env.BASTION_RUN_LEASE_MS,
    cursors: {
      get: (k) => redis.get(k),
      set: async (k, v) => {
        await redis.set(k, v, 'EX', 60 * 60 * 24 * 30);
      },
      compareAndSet: async (k, expected, next) =>
        Number(await redis.eval(CURSOR_CAS_LUA, 1, k, expected ?? '', expected === null ? '1' : '0', next, String(60 * 60 * 24 * 30))) === 1,
    },
    sealCache,
  };
  return deps;
}
