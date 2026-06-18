import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { banterFeedWeights, banterAuditLog } from '../db/schema/index.js';
import {
  effectiveWeights,
  weightsVersion,
  PLATFORM_DEFAULTS,
  type FeedWeights,
  type FeedWeightsOverride,
} from '@bigbluebam/shared';

/**
 * Feed weights service (banter-feed-design-document.md §7.2, §9). Two-level
 * tunable weight sets (platform + org). Effective = deepMerge(defaults,
 * platform, org). Writes bump `version` (feeds the read-path cache key, so
 * tuning is live) and append a banter_audit_log row.
 */

export interface WeightsView {
  effective: FeedWeights;
  defaults: FeedWeights;
  version: number;
  platform: { weights: FeedWeightsOverride; version: number } | null;
  org: { weights: FeedWeightsOverride; version: number } | null;
}

async function loadRows(orgId: string) {
  // The weights table is tiny (one platform row + one row per org), so a full
  // scan + in-code filter is cheaper than two round-trips.
  const rows = await db
    .select({
      scope: banterFeedWeights.scope,
      org_id: banterFeedWeights.org_id,
      weights: banterFeedWeights.weights,
      version: banterFeedWeights.version,
    })
    .from(banterFeedWeights);
  const platform = rows.find((r) => r.scope === 'platform') ?? null;
  const org = rows.find((r) => r.scope === 'org' && r.org_id === orgId) ?? null;
  return { platform, org };
}

/** Effective weights + the raw platform/org overrides, for the settings UI. */
export async function getWeightsView(orgId: string): Promise<WeightsView> {
  const { platform, org } = await loadRows(orgId);
  const effective = effectiveWeights(
    (platform?.weights as FeedWeightsOverride | undefined) ?? null,
    (org?.weights as FeedWeightsOverride | undefined) ?? null,
  );
  return {
    effective,
    defaults: PLATFORM_DEFAULTS,
    version: weightsVersion(platform?.version ?? 1, org?.version ?? 1),
    platform: platform
      ? { weights: platform.weights as FeedWeightsOverride, version: platform.version }
      : null,
    org: org ? { weights: org.weights as FeedWeightsOverride, version: org.version } : null,
  };
}

async function audit(orgId: string, userId: string, action: string, details: unknown) {
  try {
    await db.insert(banterAuditLog).values({
      org_id: orgId,
      user_id: userId,
      action,
      entity_type: 'feed_weights',
      entity_id: null,
      details: details as Record<string, unknown>,
    });
  } catch {
    // Audit is best-effort; never block the write.
  }
}

/** Upsert the org-level overrides (admin). Stores a partial override object. */
export async function upsertOrgWeights(
  orgId: string,
  weights: FeedWeightsOverride,
  userId: string,
): Promise<{ version: number }> {
  const [existing] = await db
    .select({ id: banterFeedWeights.id, version: banterFeedWeights.version })
    .from(banterFeedWeights)
    .where(and(eq(banterFeedWeights.scope, 'org'), eq(banterFeedWeights.org_id, orgId)))
    .limit(1);

  let version: number;
  if (existing) {
    version = existing.version + 1;
    await db
      .update(banterFeedWeights)
      .set({ weights, version, updated_by: userId, updated_at: new Date() })
      .where(eq(banterFeedWeights.id, existing.id));
  } else {
    version = 1;
    await db.insert(banterFeedWeights).values({
      scope: 'org',
      org_id: orgId,
      weights,
      version,
      updated_by: userId,
    });
  }
  await audit(orgId, userId, 'feed.weights.org_updated', { version });
  return { version };
}

/** Upsert the platform default overrides (SuperUser). auditOrgId = editor's org. */
export async function upsertPlatformWeights(
  weights: FeedWeightsOverride,
  userId: string,
  auditOrgId: string,
): Promise<{ version: number }> {
  const [existing] = await db
    .select({ id: banterFeedWeights.id, version: banterFeedWeights.version })
    .from(banterFeedWeights)
    .where(and(eq(banterFeedWeights.scope, 'platform'), isNull(banterFeedWeights.org_id)))
    .limit(1);

  let version: number;
  if (existing) {
    version = existing.version + 1;
    await db
      .update(banterFeedWeights)
      .set({ weights, version, updated_by: userId, updated_at: new Date() })
      .where(eq(banterFeedWeights.id, existing.id));
  } else {
    version = 1;
    await db.insert(banterFeedWeights).values({
      scope: 'platform',
      org_id: null,
      weights,
      version,
      updated_by: userId,
    });
  }
  await audit(auditOrgId, userId, 'feed.weights.platform_updated', { version });
  return { version };
}
