import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { braidOrgSettings } from '../db/schema/index.js';
import { SourceTypeNotSupportedError } from '../lib/errors.js';
import type { BraidUpdateSettingsInput } from './types.js';

// The source types whose visibility branch is verified this cycle (spec 2.5 / 5.5).
// A type is offered to PATCH /settings only if it is in here; enabling anything else
// returns a typed SOURCE_TYPE_NOT_SUPPORTED. helpdesk.user is intentionally ABSENT
// until its real REQUESTER-read predicate (not the permissive triage carve-out) is
// mirrored in visibility.service.ts (spec 2.5, S-r2-4).
export const SUPPORTED_BRAID_SOURCE_TYPES = new Set<string>([
  'bond.contact',
  'bond.company',
  'bill.client',
  'book.event_attendee',
]);

export interface ResolvedBraidSettings {
  auto_merge_threshold: number;
  review_threshold: number;
  require_strong_signal_for_auto: boolean;
  enabled_source_types: string[];
  rescan_max_age_days: number | null;
  last_rescan_at: string | null;
}

const DEFAULTS: ResolvedBraidSettings = {
  auto_merge_threshold: 0.92,
  review_threshold: 0.6,
  require_strong_signal_for_auto: true,
  enabled_source_types: [],
  rescan_max_age_days: null,
  last_rescan_at: null,
};

function toResolved(row: typeof braidOrgSettings.$inferSelect | undefined): ResolvedBraidSettings {
  if (!row) return { ...DEFAULTS };
  return {
    auto_merge_threshold: Number(row.auto_merge_threshold),
    review_threshold: Number(row.review_threshold),
    require_strong_signal_for_auto: row.require_strong_signal_for_auto,
    enabled_source_types: Array.isArray(row.enabled_source_types)
      ? (row.enabled_source_types as string[])
      : [],
    rescan_max_age_days: row.rescan_max_age_days ?? null,
    last_rescan_at: row.last_rescan_at ? new Date(row.last_rescan_at).toISOString() : null,
  };
}

export async function getSettings(orgId: string): Promise<ResolvedBraidSettings> {
  const [row] = await db
    .select()
    .from(braidOrgSettings)
    .where(eq(braidOrgSettings.organization_id, orgId))
    .limit(1);
  return toResolved(row);
}

// Upsert (one row per org, guarded by the unique index on organization_id).
// Enforces the source-type enablement gate (spec 5.5) before writing.
export async function updateSettings(
  orgId: string,
  userId: string,
  input: BraidUpdateSettingsInput,
): Promise<ResolvedBraidSettings> {
  if (input.enabled_source_types) {
    for (const t of input.enabled_source_types) {
      if (!SUPPORTED_BRAID_SOURCE_TYPES.has(t)) throw new SourceTypeNotSupportedError(t);
    }
  }

  const patch: Record<string, unknown> = { updated_by: userId, updated_at: new Date() };
  if (input.auto_merge_threshold !== undefined)
    patch.auto_merge_threshold = String(input.auto_merge_threshold);
  if (input.review_threshold !== undefined)
    patch.review_threshold = String(input.review_threshold);
  if (input.require_strong_signal_for_auto !== undefined)
    patch.require_strong_signal_for_auto = input.require_strong_signal_for_auto;
  if (input.enabled_source_types !== undefined)
    patch.enabled_source_types = input.enabled_source_types;
  if (input.rescan_max_age_days !== undefined)
    patch.rescan_max_age_days = input.rescan_max_age_days;

  await db
    .insert(braidOrgSettings)
    .values({ organization_id: orgId, ...patch })
    .onConflictDoUpdate({ target: braidOrgSettings.organization_id, set: patch });

  return getSettings(orgId);
}
