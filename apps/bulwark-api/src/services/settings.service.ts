import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { bulwarkUpdateSettingsSchema, type BulwarkOrgSettings } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { bulwarkOrgSettings } from '../db/schema/index.js';
import { ValidationFailure } from '../lib/errors.js';

type UpdateInput = z.infer<typeof bulwarkUpdateSettingsSchema>;

const DEFAULTS: BulwarkOrgSettings = {
  default_timezone: 'UTC',
  auto_confirm_threshold: 0.95,
  radar_lead_times: { critical_hours: 24, high_hours: 72, medium_hours: 168 },
  auto_draft_notices: false,
  auto_draft_max_per_sweep: 20,
  notice_llm_daily_cap: 100,
  chase_cadence_days: 7,
  coi_expiry_lead_days: 30,
  discharged_deadline_retention_days: 365,
  inbox_retention_days: 400,
  llm_provider_id: null,
  last_radar_sweep_at: null,
};

function toResolved(row: typeof bulwarkOrgSettings.$inferSelect | undefined): BulwarkOrgSettings {
  if (!row) return { ...DEFAULTS };
  return {
    default_timezone: row.default_timezone,
    auto_confirm_threshold: Number(row.auto_confirm_threshold),
    radar_lead_times: row.radar_lead_times as BulwarkOrgSettings['radar_lead_times'],
    auto_draft_notices: row.auto_draft_notices,
    auto_draft_max_per_sweep: row.auto_draft_max_per_sweep,
    notice_llm_daily_cap: row.notice_llm_daily_cap,
    chase_cadence_days: row.chase_cadence_days,
    coi_expiry_lead_days: row.coi_expiry_lead_days,
    discharged_deadline_retention_days: row.discharged_deadline_retention_days,
    inbox_retention_days: row.inbox_retention_days,
    llm_provider_id: row.llm_provider_id ?? null,
    last_radar_sweep_at: row.last_radar_sweep_at
      ? new Date(row.last_radar_sweep_at).toISOString()
      : null,
  };
}

export async function getSettings(orgId: string): Promise<BulwarkOrgSettings> {
  const [row] = await db
    .select()
    .from(bulwarkOrgSettings)
    .where(eq(bulwarkOrgSettings.organization_id, orgId))
    .limit(1);
  return toResolved(row);
}

// Update (one row per org, guarded by the unique index on organization_id). Enforces
// inbox_retention_days >= discharged_deadline_retention_days (STJ7) using the EFFECTIVE
// values after the patch, because either field may be updated alone.
export async function updateSettings(
  orgId: string,
  userId: string,
  input: UpdateInput,
): Promise<BulwarkOrgSettings> {
  const current = await getSettings(orgId);
  const effectiveInbox = input.inbox_retention_days ?? current.inbox_retention_days;
  const effectiveDischarged =
    input.discharged_deadline_retention_days ?? current.discharged_deadline_retention_days;
  if (effectiveInbox < effectiveDischarged) {
    throw new ValidationFailure(
      'inbox_retention_days must be >= discharged_deadline_retention_days (a late redelivery could otherwise re-arm a purged clock)',
      'RETENTION_FLOOR_VIOLATION',
    );
  }

  const patch: Record<string, unknown> = { updated_by: userId, updated_at: new Date() };
  if (input.default_timezone !== undefined) patch.default_timezone = input.default_timezone;
  if (input.auto_confirm_threshold !== undefined)
    patch.auto_confirm_threshold = String(input.auto_confirm_threshold);
  if (input.radar_lead_times !== undefined) patch.radar_lead_times = input.radar_lead_times;
  if (input.auto_draft_notices !== undefined) patch.auto_draft_notices = input.auto_draft_notices;
  if (input.auto_draft_max_per_sweep !== undefined)
    patch.auto_draft_max_per_sweep = input.auto_draft_max_per_sweep;
  if (input.notice_llm_daily_cap !== undefined)
    patch.notice_llm_daily_cap = input.notice_llm_daily_cap;
  if (input.chase_cadence_days !== undefined) patch.chase_cadence_days = input.chase_cadence_days;
  if (input.coi_expiry_lead_days !== undefined)
    patch.coi_expiry_lead_days = input.coi_expiry_lead_days;
  if (input.discharged_deadline_retention_days !== undefined)
    patch.discharged_deadline_retention_days = input.discharged_deadline_retention_days;
  if (input.inbox_retention_days !== undefined)
    patch.inbox_retention_days = input.inbox_retention_days;
  if (input.llm_provider_id !== undefined) patch.llm_provider_id = input.llm_provider_id;

  await db
    .insert(bulwarkOrgSettings)
    .values({ organization_id: orgId, ...patch })
    .onConflictDoUpdate({ target: bulwarkOrgSettings.organization_id, set: patch });

  return getSettings(orgId);
}
