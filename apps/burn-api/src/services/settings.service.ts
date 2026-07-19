import { and, count, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { BurnSettingsUpdate } from '@bigbluebam/shared';
import { runInOrgScope } from '../plugins/rls.js';
import type { DbTx } from '../db/index.js';
import { burnOrgSettings, burnPrechecks, burnDeliverables } from '../db/schema/index.js';
import { NotFoundError, ValidationFailure } from '../lib/errors.js';
import type { Viewer } from './types.js';

/**
 * Burn org settings. Every knob in spec 3.1's burn_org_settings, including gate_mode.
 *
 * The row is created lazily on first read with the DB defaults, so a freshly migrated org
 * never 404s on /v1/settings and the gate reads `off` rather than undefined.
 */
export async function loadSettings(tx: DbTx, orgId: string) {
  const [row] = await tx
    .select()
    .from(burnOrgSettings)
    .where(eq(burnOrgSettings.organization_id, orgId))
    .limit(1);
  if (row) return row;
  await tx
    .insert(burnOrgSettings)
    .values({ organization_id: orgId })
    .onConflictDoNothing();
  const [created] = await tx
    .select()
    .from(burnOrgSettings)
    .where(eq(burnOrgSettings.organization_id, orgId))
    .limit(1);
  if (!created) throw new NotFoundError('Burn settings could not be initialized for this org');
  return created;
}

export async function getSettings(viewer: Viewer) {
  return runInOrgScope(viewer.org_id, async (tx) => ({ data: await loadSettings(tx, viewer.org_id) }));
}

/* ------------------------------------------------------------------ */
/*  The seven promotion preconditions (spec 5.4)                      */
/* ------------------------------------------------------------------ */

export interface PreconditionStanding {
  key: string;
  label: string;
  satisfied: boolean;
  actual: number | string | boolean | null;
  required: number | string | boolean | null;
  shortfall: string | null;
}

export interface CalibrationReport {
  gate_mode: string;
  eligible_for_blocking: boolean;
  preconditions: PreconditionStanding[];
  gate_coverage_pct: number | null;
  gate_unavailable_days: number;
  gate_not_configured_days: number;
}

const DAY_MS = 86_400_000;

function pass(
  key: string,
  label: string,
  satisfied: boolean,
  actual: PreconditionStanding['actual'],
  required: PreconditionStanding['required'],
  shortfall: string,
): PreconditionStanding {
  return { key, label, satisfied, actual, required, shortfall: satisfied ? null : shortfall };
}

/**
 * Coverage over the trailing 7 days, drained from the Redis counters bill-api increments
 * (spec 5.5.2). `burn:gate_calls:<org>:<yyyymmdd>` is the denominator and is incremented on
 * EVERY gated write attempt including the unconfigured no-op, so a missing
 * BURN_API_INTERNAL_URL reads as 0 percent rather than 0/0.
 *
 * Returns null (not 0) when the denominator is genuinely zero across the whole window, i.e.
 * the org posted no gated writes at all. Zero traffic is not a coverage failure and must not
 * be allowed to auto-demote a healthy gate.
 */
export async function readGateCoverage(
  redis: { get(key: string): Promise<string | null> },
  orgId: string,
  now = new Date(),
): Promise<{ coveragePct: number | null; unavailableDays: number; notConfiguredDays: number }> {
  let calls = 0;
  let failures = 0;
  let unavailableDays = 0;
  let notConfiguredDays = 0;
  for (let i = 0; i < 7; i++) {
    const day = new Date(now.getTime() - i * DAY_MS).toISOString().slice(0, 10).replace(/-/g, '');
    const [c, u, n] = await Promise.all([
      redis.get(`burn:gate_calls:${orgId}:${day}`).catch(() => null),
      redis.get(`burn:gate_unavailable:${orgId}:${day}`).catch(() => null),
      redis.get(`burn:gate_unconfigured:${orgId}:${day}`).catch(() => null),
    ]);
    const dayCalls = Number(c ?? 0) || 0;
    const dayUnavailable = Number(u ?? 0) || 0;
    const dayNotConfigured = Number(n ?? 0) || 0;
    calls += dayCalls;
    failures += dayUnavailable + dayNotConfigured;
    if (dayUnavailable > 0) unavailableDays += 1;
    if (dayNotConfigured > 0) notConfiguredDays += 1;
  }
  const coveragePct = calls > 0 ? (calls - failures) / calls : null;
  return { coveragePct, unavailableDays, notConfiguredDays };
}

/**
 * Standing against all seven preconditions, with the shortfall NAMED (spec 5.4).
 *
 * Precondition 1 counts ONLY `svc:`-namespaced calibrating rows. That restriction is the
 * whole of the R2-S8 fix: without it a member scripts 200 `work_ref_type: 'manual'`
 * prechecks in seconds and satisfies the volume gate on a wholly synthetic sample, promoting
 * the org into blocking mode on evidence they manufactured.
 */
export async function computeCalibration(
  tx: DbTx,
  orgId: string,
  redis: { get(key: string): Promise<string | null> },
  now = new Date(),
): Promise<CalibrationReport> {
  const settings = await loadSettings(tx, orgId);

  const [volumeRow] = await tx
    .select({ n: count() })
    .from(burnPrechecks)
    .where(
      and(
        eq(burnPrechecks.organization_id, orgId),
        eq(burnPrechecks.is_calibrating, true),
        sql`${burnPrechecks.idempotency_key} LIKE 'svc:%'`,
        isNull(burnPrechecks.superseded_at),
      ),
    );
  const svcDecisions = Number(volumeRow?.n ?? 0);

  const [firstRow] = await tx
    .select({ first: sql<Date | null>`min(${burnPrechecks.created_at})` })
    .from(burnPrechecks)
    .where(eq(burnPrechecks.organization_id, orgId));
  const firstAt = firstRow?.first ? new Date(firstRow.first) : null;
  const advisoryDays = firstAt ? Math.floor((now.getTime() - firstAt.getTime()) / DAY_MS) : 0;

  const [labeledRow] = await tx
    .select({ n: count() })
    .from(burnPrechecks)
    .where(
      and(
        eq(burnPrechecks.organization_id, orgId),
        eq(burnPrechecks.verdict, 'deny'),
        isNotNull(burnPrechecks.advisory_feedback),
      ),
    );
  const labeledDenies = Number(labeledRow?.n ?? 0);

  // Precision counts ONLY the two owner/admin-writable values in the numerator
  // (spec 2.4 point 9). right_call and would_have_mapped are member-writable and feed
  // nothing, so a member cannot move precision in either direction.
  const [wrongRow] = await tx
    .select({ n: count() })
    .from(burnPrechecks)
    .where(
      and(
        eq(burnPrechecks.organization_id, orgId),
        eq(burnPrechecks.verdict, 'deny'),
        sql`(${burnPrechecks.advisory_feedback} = 'wrong_call' OR ${burnPrechecks.override_reason_code} = 'gate_wrong')`,
      ),
    );
  const wrongCalls = Number(wrongRow?.n ?? 0);
  const precision = labeledDenies > 0 ? (labeledDenies - wrongCalls) / labeledDenies : 0;

  const coverage = await readGateCoverage(redis, orgId, now);

  const [pricedRow] = await tx
    .select({
      total: count(),
      priced: sql<number>`count(*) FILTER (WHERE ${burnDeliverables.envelope_amount} IS NOT NULL AND ${burnDeliverables.envelope_source} <> 'unpriced')`,
    })
    .from(burnDeliverables)
    .where(
      and(
        eq(burnDeliverables.organization_id, orgId),
        eq(burnDeliverables.is_active, true),
        eq(burnDeliverables.review_status, 'confirmed'),
      ),
    );
  const totalActive = Number(pricedRow?.total ?? 0);
  const pricedActive = Number(pricedRow?.priced ?? 0);
  const pricedPct = totalActive > 0 ? (pricedActive / totalActive) * 100 : 0;

  const minDecisions = Number(settings.min_advisory_decisions ?? 200);
  const minDaysAlt = Number(settings.min_advisory_days_alt ?? 60);
  const minDays = Number(settings.min_advisory_days ?? 14);
  const minLabeled = Number(settings.min_labeled_denies ?? 10);
  const minPrecision = Number(settings.min_deny_precision ?? 0.95);
  const minCoverage = Number(settings.min_gate_coverage_pct ?? 0.9);
  const minPricedPct = Number(settings.min_priced_deliverable_coverage_pct ?? 60);

  const preconditions: PreconditionStanding[] = [
    // "the LESSER of" -- 200 svc: decisions OR 60 advisory days. A 6-person consultancy
    // reaches 200 expenses in about ten months, so the days branch is the one that actually
    // fires for a small firm, which is the point.
    pass(
      'volume',
      'Advisory decision volume',
      svcDecisions >= minDecisions || advisoryDays >= minDaysAlt,
      svcDecisions,
      minDecisions,
      `${minDecisions - svcDecisions} more service-namespaced advisory decisions, or ${Math.max(0, minDaysAlt - advisoryDays)} more days of advisory operation`,
    ),
    pass(
      'soak',
      'Days in advisory mode',
      advisoryDays >= minDays,
      advisoryDays,
      minDays,
      `${Math.max(0, minDays - advisoryDays)} more days of advisory operation`,
    ),
    pass(
      'labeled_denies',
      'Labeled advisory denies',
      labeledDenies >= minLabeled,
      labeledDenies,
      minLabeled,
      `${Math.max(0, minLabeled - labeledDenies)} more advisory denies need a review label`,
    ),
    pass(
      'precision',
      'Deny precision on the labeled sample',
      labeledDenies >= minLabeled && precision >= minPrecision,
      Number(precision.toFixed(4)),
      minPrecision,
      `deny precision is ${(precision * 100).toFixed(1)} percent against a required ${(minPrecision * 100).toFixed(1)} percent`,
    ),
    pass(
      'gate_coverage',
      'Gate coverage over the trailing 7 days',
      coverage.coveragePct !== null && coverage.coveragePct >= minCoverage,
      coverage.coveragePct === null ? null : Number(coverage.coveragePct.toFixed(4)),
      minCoverage,
      coverage.coveragePct === null
        ? 'no gated writes have been attempted in the last 7 days, so coverage cannot be established'
        : `coverage is ${(coverage.coveragePct * 100).toFixed(1)} percent against a required ${(minCoverage * 100).toFixed(1)} percent`,
    ),
    pass(
      'priced_coverage',
      'Priced active deliverables',
      pricedPct >= minPricedPct,
      Number(pricedPct.toFixed(2)),
      minPricedPct,
      `${pricedPct.toFixed(1)} percent of active deliverables are priced against a required ${minPricedPct} percent; an unpriced envelope can never produce a deny, so promoting now would enforce nothing`,
    ),
    // Precondition 7 is supplied by the CALLER on the promoting request, not stored, so it
    // is reported as unsatisfied here and checked in updateSettings.
    pass(
      'acknowledgement',
      'Explicit blocking acknowledgement',
      false,
      false,
      true,
      'the promotion request must carry acknowledge_blocking: true after the wizard has shown the last 20 advisory denies with their labels and outcomes',
    ),
  ];

  return {
    gate_mode: settings.gate_mode,
    eligible_for_blocking: preconditions.every((p) => p.satisfied || p.key === 'acknowledgement'),
    preconditions,
    gate_coverage_pct: coverage.coveragePct,
    gate_unavailable_days: coverage.unavailableDays,
    gate_not_configured_days: coverage.notConfiguredDays,
  };
}

export async function getCalibration(
  viewer: Viewer,
  redis: { get(key: string): Promise<string | null> },
) {
  return runInOrgScope(viewer.org_id, async (tx) => ({
    data: await computeCalibration(tx, viewer.org_id, redis),
  }));
}

/* ------------------------------------------------------------------ */
/*  PATCH /v1/settings                                                */
/* ------------------------------------------------------------------ */

export interface SettingsUpdateExtras {
  acknowledge_blocking?: boolean;
}

/**
 * Validate that an llm_provider_id belongs to the caller's org (spec 2.4 point 12).
 *
 * apps/api's internal-llm.routes.ts resolves a provider by `id` and `enabled` only, with NO
 * org predicate, so a Burn org admin who learned another tenant's provider id would get that
 * tenant's decrypted API key used on their behalf and billed to their account. Burn validates
 * ownership here regardless of what the platform does; the platform gap is tracked
 * separately and is not Burn's to fix.
 */
async function assertProviderOwnedByOrg(tx: DbTx, orgId: string, providerId: string) {
  const rows = await tx.execute(
    sql`SELECT id FROM llm_providers WHERE id = ${providerId} AND organization_id = ${orgId} LIMIT 1`,
  );
  const found = Array.isArray(rows) ? rows.length > 0 : (rows as { length?: number })?.length;
  if (!found) {
    throw new ValidationFailure(
      'llm_provider_id does not belong to this organization',
      'INVALID_LLM_PROVIDER',
    );
  }
}

export async function updateSettings(
  viewer: Viewer,
  patch: BurnSettingsUpdate,
  extras: SettingsUpdateExtras,
  redis: { get(key: string): Promise<string | null> },
) {
  return runInOrgScope(viewer.org_id, async (tx) => {
    const current = await loadSettings(tx, viewer.org_id);

    if (patch.llm_provider_id) {
      await assertProviderOwnedByOrg(tx, viewer.org_id, patch.llm_provider_id);
    }

    // The two classes that can never be marked blocking (spec 5.2). Both are observed AFTER
    // the fact through a Bolt event, so there is no pre-transaction moment at which they
    // could block anything; accepting them would produce a setting that silently does
    // nothing, which is worse than a rejection.
    if (patch.gate_enabled_refs) {
      const forbidden = patch.gate_enabled_refs.filter(
        (r) => r === 'bam.task_phase_move' || r === 'bam.assignment',
      );
      if (forbidden.length > 0 && (patch.gate_mode ?? current.gate_mode) === 'blocking') {
        throw new ValidationFailure(
          `These classes are advisory forever and cannot be enabled for blocking: ${forbidden.join(', ')}. They are observed post-hoc through Bolt events, after the write has already committed.`,
          'CLASS_NOT_BLOCKING_ELIGIBLE',
        );
      }
    }

    if (patch.gate_mode === 'blocking' && current.gate_mode !== 'blocking') {
      const report = await computeCalibration(tx, viewer.org_id, redis);
      const failed = report.preconditions.filter(
        (p) => !p.satisfied && p.key !== 'acknowledgement',
      );
      if (!extras.acknowledge_blocking) {
        failed.push(
          report.preconditions.find((p) => p.key === 'acknowledgement')!,
        );
      }
      if (failed.length > 0) {
        throw new ValidationFailure(
          `Cannot promote the gate to blocking. Unmet preconditions: ${failed
            .map((f) => `${f.key} (${f.shortfall})`)
            .join('; ')}`,
          'PROMOTION_PRECONDITIONS_UNMET',
        );
      }
    }

    const values: Record<string, unknown> = { ...patch, updated_by: viewer.id, updated_at: new Date() };
    if (patch.gate_paused_until !== undefined) {
      values.gate_paused_until = patch.gate_paused_until ? new Date(patch.gate_paused_until) : null;
    }
    if (patch.gate_mode === 'blocking' && current.gate_mode !== 'blocking') {
      values.gate_promoted_at = new Date();
    }

    const [updated] = await tx
      .update(burnOrgSettings)
      .set(values)
      .where(eq(burnOrgSettings.organization_id, viewer.org_id))
      .returning();

    return { data: updated, previous_gate_mode: current.gate_mode };
  });
}

/** Whether the gate is currently in force for a given work-ref class. */
export function gateIsBlockingFor(
  settings: { gate_mode: string; gate_enabled_refs: unknown; gate_paused_until: Date | null },
  workRefType: string,
  now = new Date(),
): boolean {
  if (settings.gate_mode !== 'blocking') return false;
  if (settings.gate_paused_until && new Date(settings.gate_paused_until) > now) return false;
  const refs = Array.isArray(settings.gate_enabled_refs)
    ? (settings.gate_enabled_refs as string[])
    : [];
  return refs.includes(workRefType);
}

/** Used by the calibration route to expose a stable window length in the response. */
export const CALIBRATION_COVERAGE_WINDOW_DAYS = 7;
