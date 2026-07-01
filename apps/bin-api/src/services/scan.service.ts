import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { env } from '../env.js';
import { NotFoundError } from './folder.service.js';

// ---------------------------------------------------------------------------
// AV scan policy + progress (Bin master §9.3, this slice).
//
// Serving is gated on scan_status; a per-org "allow work before the scan
// completes" policy plus a persistent per-file override loosen that gate.
// Both the serving gate (asset.service) and the /scan endpoints resolve the
// effective policy through here so precedence is defined in exactly one place.
//
//   allow_unscanned_access precedence:
//     org override (organizations.settings.av.allow_unscanned_access)
//       -> platform default (system_settings['av.allow_unscanned_access'])
//         -> env BIN_ALLOW_UNSCANNED_ACCESS (default false)
//
// The org override may be null (not set) to fall through to the platform layer.
// ---------------------------------------------------------------------------

/** Coerce a JSONB-stored setting value into a boolean. The system_settings
 *  value column holds already-parsed JSON (postgres-js), so a boolean arrives
 *  as a JS boolean; we still tolerate the "true"/"false" string forms. */
function asBool(raw: unknown): boolean | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') {
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  }
  return null;
}

function rowsOf<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] })?.rows ?? [])) as T[];
}

async function readSystemSetting(key: string): Promise<unknown> {
  const raw = await db.execute(sql`SELECT value FROM system_settings WHERE key = ${key} LIMIT 1`);
  const list = rowsOf<{ value: unknown }>(raw);
  return list[0]?.value ?? null;
}

async function readOrgAvOverride(orgId: string): Promise<boolean | null> {
  const raw = await db.execute(
    sql`SELECT settings -> 'av' -> 'allow_unscanned_access' AS v FROM organizations WHERE id = ${orgId} LIMIT 1`,
  );
  const list = rowsOf<{ v: unknown }>(raw);
  return asBool(list[0]?.v);
}

export interface EffectiveScanPolicy {
  /** The resolved effective value used by the serving gate. */
  allow_unscanned_access: boolean;
  /** Configured scan mode (display only): off | eicar | clamav. */
  scan_mode: string;
  /** The org's own override, or null when it falls through to the platform. */
  org_override: boolean | null;
}

/** Resolve the effective allow-unscanned policy + scan mode for an org. */
export async function resolveScanPolicy(orgId: string): Promise<EffectiveScanPolicy> {
  const [orgOverride, platformRaw, modeRaw] = await Promise.all([
    readOrgAvOverride(orgId),
    readSystemSetting('av.allow_unscanned_access'),
    readSystemSetting('av.scan_mode'),
  ]);
  const platform = asBool(platformRaw);
  const effective = orgOverride ?? platform ?? env.BIN_ALLOW_UNSCANNED_ACCESS;
  const scanMode = typeof modeRaw === 'string' && modeRaw ? modeRaw : 'eicar';
  return { allow_unscanned_access: effective, scan_mode: scanMode, org_override: orgOverride };
}

/** Set (or clear, with null) the org's allow-unscanned override. */
export async function setOrgScanPolicy(orgId: string, value: boolean | null): Promise<void> {
  if (value === null) {
    // Remove the key so the org falls back to the platform default.
    await db.execute(
      sql`UPDATE organizations SET settings = (settings #- '{av,allow_unscanned_access}') WHERE id = ${orgId}`,
    );
    return;
  }
  await db.execute(
    sql`UPDATE organizations
        SET settings = jsonb_set(
          jsonb_set(COALESCE(settings, '{}'::jsonb), '{av}', COALESCE(settings -> 'av', '{}'::jsonb), true),
          '{av,allow_unscanned_access}', to_jsonb(${value}::boolean), true)
        WHERE id = ${orgId}`,
  );
}

export interface ScanOverview {
  counts: { pending: number; clean: number; infected: number; error: number; skipped: number };
  scan_mode: string;
  allow_unscanned_access: boolean;
  oldest_pending_age_sec: number | null;
  recent_errors: { id: string; name: string; updated_at: string | null }[];
  can_override: boolean;
}

/** Org-scoped scan progress: counts by status, oldest pending age, recent
 *  errored files, and the effective policy + caller override capability. */
export async function getScanOverview(
  orgId: string,
  canOverride: boolean,
): Promise<ScanOverview> {
  const policy = await resolveScanPolicy(orgId);

  const countsRaw = await db.execute(sql`
    SELECT scan_status, COUNT(*)::int AS n
    FROM bin_assets
    WHERE org_id = ${orgId} AND archived_at IS NULL
    GROUP BY scan_status
  `);
  const counts = { pending: 0, clean: 0, infected: 0, error: 0, skipped: 0 };
  for (const r of rowsOf<{ scan_status: string; n: number }>(countsRaw)) {
    if (r.scan_status in counts) counts[r.scan_status as keyof typeof counts] = Number(r.n);
  }

  const oldestRaw = await db.execute(sql`
    SELECT EXTRACT(EPOCH FROM (now() - MIN(created_at)))::int AS age
    FROM bin_assets
    WHERE org_id = ${orgId} AND archived_at IS NULL
      AND scan_status = 'pending' AND object_key <> ''
  `);
  const oldest = rowsOf<{ age: number | null }>(oldestRaw)[0]?.age ?? null;

  const errorsRaw = await db.execute(sql`
    SELECT id, name, created_at
    FROM bin_assets
    WHERE org_id = ${orgId} AND archived_at IS NULL AND scan_status = 'error'
    ORDER BY created_at DESC
    LIMIT 10
  `);
  const recent_errors = rowsOf<{ id: string; name: string; created_at: string | null }>(errorsRaw).map(
    (r) => ({ id: r.id, name: r.name, updated_at: r.created_at }),
  );

  return {
    counts,
    scan_mode: policy.scan_mode,
    allow_unscanned_access: policy.allow_unscanned_access,
    oldest_pending_age_sec: oldest === null ? null : Number(oldest),
    recent_errors,
    can_override: canOverride,
  };
}

/** Set or clear the persistent per-file scan override (false-positive clear).
 *  Org-scoped; 404 if the asset is not in this org. Returns the updated row. */
export async function setScanOverride(
  assetId: string,
  orgId: string,
  userId: string,
  allow: boolean,
  reason: string | null,
) {
  const now = allow ? new Date() : null;
  const rows = await db.execute(sql`
    UPDATE bin_assets
    SET scan_override_at = ${now},
        scan_overridden_by = ${allow ? userId : null},
        scan_override_reason = ${allow ? reason : null}
    WHERE id = ${assetId} AND org_id = ${orgId}
    RETURNING id, scan_override_at, scan_overridden_by, scan_override_reason
  `);
  const list = rowsOf<{
    id: string;
    scan_override_at: string | null;
    scan_overridden_by: string | null;
    scan_override_reason: string | null;
  }>(rows);
  if (list.length === 0) throw new NotFoundError('Asset not found');
  return list[0]!;
}
