// Redis-backed cache with in-process Map fallback.
//
// Mirrors the pattern in apps/mcp-server/src/lib/confirm-token-store.ts
// so the permissions resolver can degrade gracefully when Redis is
// unavailable. The fallback is per-process so a multi-replica deploy
// without Redis loses cross-replica invalidation, but no replica ever
// returns a stale-by-default value (TTL is short).

export interface CacheClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(keys: readonly string[]): Promise<void>;
  publish?(channel: string, message: string): Promise<void>;
  subscribe?(channel: string, handler: (message: string) => void): Promise<void>;
}

interface FallbackEntry {
  value: string;
  expires_at: number;
}

/**
 * Tiny in-process cache used when Redis is absent. Capped at MAX_KEYS
 * so a runaway producer doesn't OOM the process. Eviction is
 * insertion-order (Map iteration is insertion-ordered in JS).
 */
class FallbackCache implements CacheClient {
  private readonly store = new Map<string, FallbackEntry>();
  private static readonly MAX_KEYS = 10_000;

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expires_at < Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.store.size >= FallbackCache.MAX_KEYS && !this.store.has(key)) {
      // Evict oldest.
      const firstKey = this.store.keys().next().value;
      if (firstKey != null) this.store.delete(firstKey);
    }
    this.store.set(key, { value, expires_at: Date.now() + ttlSeconds * 1000 });
  }

  async del(keys: readonly string[]): Promise<void> {
    for (const k of keys) this.store.delete(k);
  }
}

/**
 * Wraps a Redis client (or compatible) with the FallbackCache. Get/set
 * try Redis first; on error, fall through to the in-process map and log
 * a warning. Pubsub is best-effort — a failing publish is logged but
 * doesn't throw, since cache invalidation is an optimization.
 */
export class PermissionsCache implements CacheClient {
  private readonly fallback = new FallbackCache();

  constructor(
    private readonly redis: CacheClient | null,
    private readonly logger?: { warn: (obj: unknown, msg?: string) => void },
  ) {}

  async get(key: string): Promise<string | null> {
    if (this.redis) {
      try {
        return await this.redis.get(key);
      } catch (err) {
        this.logger?.warn({ err, key }, 'permissions-cache: redis get failed; using fallback');
      }
    }
    return this.fallback.get(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.set(key, value, ttlSeconds);
        return;
      } catch (err) {
        this.logger?.warn({ err, key }, 'permissions-cache: redis set failed; using fallback');
      }
    }
    await this.fallback.set(key, value, ttlSeconds);
  }

  async del(keys: readonly string[]): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.del(keys);
      } catch (err) {
        this.logger?.warn({ err, keys }, 'permissions-cache: redis del failed; clearing fallback only');
      }
    }
    await this.fallback.del(keys);
  }

  async publish(channel: string, message: string): Promise<void> {
    if (this.redis?.publish) {
      try {
        await this.redis.publish(channel, message);
      } catch (err) {
        this.logger?.warn({ err, channel }, 'permissions-cache: redis publish failed (best-effort)');
      }
    }
  }

  async subscribe(channel: string, handler: (message: string) => void): Promise<void> {
    if (this.redis?.subscribe) {
      await this.redis.subscribe(channel, handler);
    }
  }
}

/** Channel names for invalidation pubsub. */
export const INVALIDATION_CHANNELS = Object.freeze({
  user: (userId: string) => `perms:invalidate:user:${userId}`,
  org: (orgId: string) => `perms:invalidate:org:${orgId}`,
  group: (groupId: string) => `perms:invalidate:group:${groupId}`,
  // The wildcard subscribe channel a subscriber listens on. The publish
  // channels above pattern-match against this.
  pattern: 'perms:invalidate:*',
});

/** Cache key shapes. Keep stable — used across replicas. */
export const CACHE_KEYS = Object.freeze({
  /** Cached resolution decision for a single (user, permission, scope). */
  decision: (userId: string, permissionId: string, scopeId: string | null) =>
    `perms:dec:${userId}:${permissionId}:${scopeId ?? 'global'}`,
  /** Cached full PermissionContext for a user (per org). */
  context: (userId: string, orgId: string) =>
    `perms:ctx:${userId}:${orgId}`,
});

export const DEFAULT_TTL_SECONDS = 300;
