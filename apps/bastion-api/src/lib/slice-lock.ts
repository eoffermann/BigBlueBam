// The cross-replica slice pre-check for the LLM slices (AI compile, questionnaire autofill), issue
// #242. It is a fast path only: the correctness fence is the run row's slice_token in Postgres.
// No env or database import, so the unit tests load it directly.

import { randomUUID } from 'node:crypto';
import type { SliceLock } from '../services/compile-ai.service.js';

/** Compare-and-delete: remove the lock only while it still carries the releasing slice's token. */
export const RELEASE_IF_OWNER_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** The ioredis subset the slice lock uses (a fake in the unit tests). */
export interface SliceLockRedis {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<string | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

/**
 * acquire answers a random token, or null when another slice holds the lock, and THROWS on a
 * Redis error (the caller then relies on the slice_token fence alone; an error is never treated
 * as acquired). release is a compare-and-delete on that token, so a slice that outlived its TTL
 * can never delete the lock of the slice that came after it.
 */
export function redisSliceLock(redis: SliceLockRedis, prefix = 'bastion:compile:slice:'): SliceLock {
  const key = (id: string) => `${prefix}${id}`;
  return {
    acquire: async (id, ttlMs) => {
      const token = randomUUID();
      return (await redis.set(key(id), token, 'PX', ttlMs, 'NX')) === 'OK' ? token : null;
    },
    release: async (id, token) => {
      await redis.eval(RELEASE_IF_OWNER_LUA, 1, key(id), token);
    },
  };
}
