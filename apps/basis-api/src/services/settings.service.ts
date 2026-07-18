import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { basisOrgSettings } from '../db/schema/index.js';
import type { UpdateBasisOrgSettingsInput } from '@bigbluebam/shared';
import { env } from '../env.js';

export interface ResolvedSettings {
  snapshot_max_age_days: number | null; // null = unbounded
  explanation_cache_ttl_seconds: number;
  default_dimension: string | null;
}

// Read the org's settings row, falling back to service defaults. `null`
// snapshot_max_age_days means unbounded retention (spec 3.1 / 6).
export async function getSettings(orgId: string): Promise<ResolvedSettings> {
  const [row] = await db
    .select()
    .from(basisOrgSettings)
    .where(eq(basisOrgSettings.organization_id, orgId))
    .limit(1);
  return {
    snapshot_max_age_days: row ? row.snapshot_max_age_days : null,
    explanation_cache_ttl_seconds:
      row?.explanation_cache_ttl_seconds ?? env.EXPLANATION_CACHE_TTL_SECONDS,
    default_dimension: row?.default_dimension ?? null,
  };
}

// Upsert (one row per org, guarded by the unique index on organization_id).
export async function upsertSettings(
  orgId: string,
  userId: string,
  input: UpdateBasisOrgSettingsInput,
): Promise<ResolvedSettings> {
  const patch: Record<string, unknown> = { updated_by: userId, updated_at: new Date() };
  for (const [k, v] of Object.entries(input)) {
    if (v !== undefined) patch[k] = v;
  }
  await db
    .insert(basisOrgSettings)
    .values({ organization_id: orgId, ...patch })
    .onConflictDoUpdate({ target: basisOrgSettings.organization_id, set: patch });
  return getSettings(orgId);
}
