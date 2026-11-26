import crypto from 'node:crypto';
import type Redis from 'ioredis';
import { stableStringify } from '@bigbluebam/shared';

const CACHE_PREFIX = 'bench:query:';
// v2 (#275): keys hashed by the old shallow serializer are never read again, so any entry primed
// under a colliding v1 key is orphaned (and expires within its 300 s TTL) rather than served.
const ADHOC_CACHE_PREFIX = 'bench:adhoc:v2:';

/**
 * Simple Redis caching for widget query results.
 */
export class CacheService {
  constructor(
    private redis: Redis,
    private defaultTtl = 60,
  ) {}

  /**
   * Widget result keys carry the org (BNC-1, #246): `bench:query:<orgId>:<widgetId>`.
   * The old `bench:query:<widgetId>` was one slot shared by every tenant, a
   * cross-tenant read and cache-poisoning primitive. `orgId` is required so no
   * caller can build an unnamespaced key.
   */
  private key(widgetId: string, orgId: string): string {
    return `${CACHE_PREFIX}${orgId}:${widgetId}`;
  }

  async get(widgetId: string, orgId: string): Promise<unknown | null> {
    const data = await this.redis.get(this.key(widgetId, orgId));
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async set(widgetId: string, orgId: string, data: unknown, ttl?: number): Promise<void> {
    const seconds = ttl ?? this.defaultTtl;
    await this.redis.setex(this.key(widgetId, orgId), seconds, JSON.stringify(data));
  }

  async invalidate(widgetId: string, orgId: string): Promise<void> {
    await this.redis.del(this.key(widgetId, orgId));
  }

  // -------------------------------------------------------------------------
  // Date-range-aware ad-hoc query caching
  // -------------------------------------------------------------------------

  /**
   * Build a deterministic cache key from query config + date range + org.
   * Returns null if the date range includes "today" (real-time presets like
   * 'today' or ranges whose end date is today or in the future), since those
   * results change continuously and should not be cached.
   */
  buildAdHocCacheKey(
    queryConfigHash: string,
    dateRange: { preset?: string; start?: string; end?: string } | undefined,
    orgId: string,
  ): string | null {
    // Skip caching for presets that include the current moment
    if (dateRange?.preset === 'today') return null;

    // If end date is today or later, skip caching
    if (dateRange?.end) {
      const endDate = new Date(dateRange.end);
      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      if (endDate >= todayStart) return null;
    }

    // No explicit end date and a preset that covers "now"
    if (dateRange?.preset && !dateRange.end) {
      // Presets like last_7_days, this_month, etc. always include today
      return null;
    }

    // Build a stable key from the config hash + date range + org
    const rangePart = dateRange
      ? `${dateRange.start ?? ''}_${dateRange.end ?? ''}_${dateRange.preset ?? ''}`
      : 'norange';
    return `${ADHOC_CACHE_PREFIX}${orgId}:${queryConfigHash}:${rangePart}`;
  }

  /**
   * Hash every input that changes an ad-hoc query's result (#275): the data source (`product`),
   * the `entity`, and the WHOLE config (measures, filters, dimensions, time dimension, date range,
   * sort, limit) at every depth. The org is in the key prefix. buildQuery takes nothing else (there
   * is no per-asker scoping), so equal hashes mean equal SQL.
   *
   * The old hash was `JSON.stringify(config, Object.keys(config).sort())`. An array replacer is a
   * property allowlist at every depth, so nested objects serialized as `{}` and product/entity
   * were left out. Any member could prime the entry a certified Basis metric then read.
   */
  hashQuery(product: string, entity: string, config: Record<string, unknown>): string {
    const material = stableStringify({ product, entity, config });
    return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32);
  }

  /** The ad-hoc cache key for one query, or null when the range includes today (not cached). */
  adHocKey(product: string, entity: string, config: { date_range?: { preset?: string; start?: string; end?: string } }, orgId: string): string | null {
    return this.buildAdHocCacheKey(this.hashQuery(product, entity, config as Record<string, unknown>), config.date_range, orgId);
  }

  async getAdHoc(cacheKey: string): Promise<unknown | null> {
    const data = await this.redis.get(cacheKey);
    if (!data) return null;
    try {
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async setAdHoc(cacheKey: string, data: unknown): Promise<void> {
    // 5-minute TTL for ad-hoc query results with historical date ranges
    await this.redis.setex(cacheKey, 300, JSON.stringify(data));
  }
}
