import { eq } from 'drizzle-orm';
import {
  BURSAR_AUDITED_SETTING_KEYS,
  type BursarAuditedSettingKey,
  type BursarSettingsUpdate,
} from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import type { DbTx } from '../db/index.js';
import { bursarOrgSettings, bursarSettingsAudit } from '../db/schema/index.js';
import { NotFoundError, ValidationFailure } from '../lib/errors.js';
import type { Viewer } from './types.js';

// Bursar org settings. Every knob in bursar_org_settings, including the detector weights,
// caps, thresholds, and lexicons. The row is created lazily on first read so a freshly
// migrated org never 404s.
//
// The load-bearing rule (spec 5.6): a PATCH computes a before/after diff over ALL audited
// setting keys and writes it to bursar_settings_audit. Auditing only the lexicons would let an
// admin zero a weight and silently suppress findings, which is exactly the attack the audit
// exists to catch.

export async function loadSettings(tx: DbTx, orgId: string) {
  const [row] = await tx
    .select()
    .from(bursarOrgSettings)
    .where(eq(bursarOrgSettings.organization_id, orgId))
    .limit(1);
  if (row) return row;
  await tx.insert(bursarOrgSettings).values({ organization_id: orgId }).onConflictDoNothing();
  const [created] = await tx
    .select()
    .from(bursarOrgSettings)
    .where(eq(bursarOrgSettings.organization_id, orgId))
    .limit(1);
  if (!created) throw new NotFoundError('Bursar settings could not be initialized for this org');
  return created;
}

export async function getSettings(viewer: Viewer) {
  return runInOrgScope(viewer.org_id, async (tx) => ({ data: await loadSettings(tx, viewer.org_id) }));
}

export interface SettingChange {
  field: BursarAuditedSettingKey;
  before: unknown;
  after: unknown;
}

/**
 * The diff, computed over EXACTLY the audited keys (kept as data so a new key cannot be
 * forgotten). Values are normalized to a comparable JSON form so a numeric/string mismatch
 * (numeric columns come back as strings from postgres-js) does not register a phantom change,
 * and an array reorder does register as a change.
 */
export function diffSettings(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): SettingChange[] {
  const changes: SettingChange[] = [];
  for (const key of BURSAR_AUDITED_SETTING_KEYS) {
    if (!(key in after)) continue; // not part of this PATCH
    const b = before[key];
    const a = after[key];
    if (JSON.stringify(normalize(b)) !== JSON.stringify(normalize(a))) {
      changes.push({ field: key, before: b ?? null, after: a ?? null });
    }
  }
  return changes;
}

// Numeric columns are returned as strings by postgres-js; a patch supplies numbers. Compare on
// numeric value when both sides parse as numbers, so 0.3 vs "0.3000" is not a false change.
function normalize(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

export async function updateSettings(viewer: Viewer, patch: BursarSettingsUpdate) {
  const keys = Object.keys(patch);
  if (keys.length === 0) {
    throw new ValidationFailure('No settings fields supplied', 'EMPTY_PATCH');
  }
  return runInOrgScope(viewer.org_id, async (tx) => {
    const current = await loadSettings(tx, viewer.org_id);

    // Build the write set. Numeric columns take string values (drizzle numeric mode); coerce
    // numbers to strings so the driver stores them without precision surprises.
    const values: Record<string, unknown> = { updated_by: viewer.id, updated_at: new Date() };
    for (const [k, v] of Object.entries(patch)) {
      values[k] = v;
    }

    const [updated] = await tx
      .update(bursarOrgSettings)
      .set(values)
      .where(eq(bursarOrgSettings.organization_id, viewer.org_id))
      .returning();

    // Audit AFTER the write, comparing the pre-write row to the post-write row over the
    // audited keys. Only record when something actually changed.
    const changes = diffSettings(
      current as unknown as Record<string, unknown>,
      updated as unknown as Record<string, unknown>,
    );
    if (changes.length > 0) {
      await tx.insert(bursarSettingsAudit).values({
        organization_id: viewer.org_id,
        actor_id: viewer.id,
        changes,
      });
    }

    return { data: updated, changed_fields: changes.map((c) => c.field) };
  });
}

/** The audit trail for the org, newest first. Read surface for the settings history view. */
export async function listSettingsAudit(viewer: Viewer, limit = 50) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const rows = await tx
      .select()
      .from(bursarSettingsAudit)
      .where(eq(bursarSettingsAudit.organization_id, viewer.org_id))
      .orderBy(bursarSettingsAudit.created_at)
      .limit(limit);
    return { data: rows };
  });
}
