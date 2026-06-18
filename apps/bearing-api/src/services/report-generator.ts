import { eq, and, or, inArray, asc } from 'drizzle-orm';
import { db } from '../db/index.js';
import {
  bearingPeriods,
  bearingGoals,
  bearingKeyResults,
  bearingKrSnapshots,
} from '../db/schema/index.js';
import { BearingError } from './period.service.js';
import { computeGoalProgress } from './progress-engine.js';

/** Group key results by goal_id for batch-loaded results */
function groupKrsByGoal(krs: Array<{ goal_id: string; [key: string]: unknown }>) {
  const map = new Map<string, typeof krs>();
  for (const kr of krs) {
    const list = map.get(kr.goal_id) ?? [];
    list.push(kr);
    map.set(kr.goal_id, list);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Structured period report (powers the dashboard stat cards + progress chart)
// ---------------------------------------------------------------------------

export interface PeriodReportData {
  period_id: string;
  period_name: string;
  total_goals: number;
  avg_progress: number;
  on_track: number;
  at_risk: number;
  behind: number;
  achieved: number;
  missed: number;
  progress_over_time: Array<{ date: string; actual: number; expected: number }>;
}

/** Format a Date as a UTC YYYY-MM-DD key. */
function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Generate the structured period report consumed by the Bearing dashboard
 * (ProgressSummary stat cards) and the goal/period progress chart
 * (ProgressChart "Progress Over Time").
 *
 * Summary counts come from the goals' current status. The `progress_over_time`
 * series is reconstructed from KR snapshots: for every day on which any KR in
 * the period recorded a snapshot, we carry forward the latest snapshot value
 * per KR and average them to an "actual" line, alongside a linear "expected"
 * ramp from 0% at the period start to 100% at the period end.
 */
export async function generatePeriodReportData(periodId: string, orgId: string): Promise<PeriodReportData> {
  const [period] = await db
    .select()
    .from(bearingPeriods)
    .where(and(eq(bearingPeriods.id, periodId), eq(bearingPeriods.organization_id, orgId)))
    .limit(1);

  if (!period) throw new BearingError('NOT_FOUND', 'Period not found', 404);

  const goals = await db
    .select()
    .from(bearingGoals)
    .where(and(eq(bearingGoals.period_id, periodId), eq(bearingGoals.organization_id, orgId)))
    .limit(500);

  const totalGoals = goals.length;
  const countByStatus = (s: string) => goals.filter((g) => g.status === s).length;

  // Average progress is computed live from each goal's key results (the stored
  // bearing_goals.progress column is a lazily-cached value that can lag behind
  // KR check-ins), so the dashboard stat reflects current KR values.
  const liveProgress = await Promise.all(goals.map((g) => computeGoalProgress(g.id)));
  const avgProgress =
    totalGoals > 0 ? liveProgress.reduce((sum, p) => sum + p, 0) / totalGoals : 0;

  // Build the progress-over-time series from KR snapshots across all goals.
  const goalIds = goals.map((g) => g.id);
  const krs =
    goalIds.length > 0
      ? await db
          .select({ id: bearingKeyResults.id })
          .from(bearingKeyResults)
          .where(inArray(bearingKeyResults.goal_id, goalIds))
      : [];
  const krIds = krs.map((k) => k.id);

  const snapshots =
    krIds.length > 0
      ? await db
          .select({
            key_result_id: bearingKrSnapshots.key_result_id,
            progress: bearingKrSnapshots.progress,
            recorded_at: bearingKrSnapshots.recorded_at,
          })
          .from(bearingKrSnapshots)
          .where(inArray(bearingKrSnapshots.key_result_id, krIds))
          .orderBy(asc(bearingKrSnapshots.recorded_at))
      : [];

  const progressOverTime: Array<{ date: string; actual: number; expected: number }> = [];

  if (snapshots.length > 0) {
    const start = new Date(`${period.starts_at}T00:00:00.000Z`).getTime();
    const end = new Date(`${period.ends_at}T00:00:00.000Z`).getTime();
    const span = end > start ? end - start : 1;

    // Distinct snapshot days, in order.
    const days: string[] = [];
    const seen = new Set<string>();
    for (const s of snapshots) {
      const key = dayKey(new Date(s.recorded_at));
      if (!seen.has(key)) {
        seen.add(key);
        days.push(key);
      }
    }

    // Carry-forward latest progress per KR as we advance through the days.
    const latestByKr = new Map<string, number>();
    let cursor = 0;
    for (const day of days) {
      // Apply every snapshot recorded on or before the end of this day.
      const dayEnd = new Date(`${day}T23:59:59.999Z`).getTime();
      while (cursor < snapshots.length && new Date(snapshots[cursor]!.recorded_at).getTime() <= dayEnd) {
        latestByKr.set(snapshots[cursor]!.key_result_id, parseFloat(snapshots[cursor]!.progress));
        cursor++;
      }

      const values = [...latestByKr.values()];
      const actual = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;

      const dayMid = new Date(`${day}T12:00:00.000Z`).getTime();
      const expectedRaw = ((dayMid - start) / span) * 100;
      const expected = Math.max(0, Math.min(100, expectedRaw));

      progressOverTime.push({
        date: day,
        actual: Number(actual.toFixed(2)),
        expected: Number(expected.toFixed(2)),
      });
    }
  }

  return {
    period_id: periodId,
    period_name: period.name,
    total_goals: totalGoals,
    avg_progress: Number(avgProgress.toFixed(2)),
    on_track: countByStatus('on_track'),
    at_risk: countByStatus('at_risk'),
    behind: countByStatus('behind'),
    achieved: countByStatus('achieved'),
    missed: countByStatus('missed'),
    progress_over_time: progressOverTime,
  };
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

/**
 * Generate a full period report in Markdown format.
 */
export async function generatePeriodReport(periodId: string, orgId: string) {
  const [period] = await db
    .select()
    .from(bearingPeriods)
    .where(and(eq(bearingPeriods.id, periodId), eq(bearingPeriods.organization_id, orgId)))
    .limit(1);

  if (!period) throw new BearingError('NOT_FOUND', 'Period not found', 404);

  const goals = await db
    .select()
    .from(bearingGoals)
    .where(and(eq(bearingGoals.period_id, periodId), eq(bearingGoals.organization_id, orgId)))
    .limit(500);

  let markdown = `# ${period.name} Report\n\n`;
  markdown += `**Type:** ${period.period_type}  \n`;
  markdown += `**Period:** ${period.starts_at} to ${period.ends_at}  \n`;
  markdown += `**Status:** ${period.status}  \n\n`;

  // Summary stats
  const totalGoals = goals.length;
  const achievedGoals = goals.filter((g) => g.status === 'achieved').length;
  const atRiskGoals = goals.filter((g) => g.status === 'at_risk' || g.status === 'behind').length;
  const avgProgress =
    totalGoals > 0
      ? goals.reduce((sum, g) => sum + parseFloat(g.progress), 0) / totalGoals
      : 0;

  markdown += `## Summary\n\n`;
  markdown += `| Metric | Value |\n`;
  markdown += `|--------|-------|\n`;
  markdown += `| Total Goals | ${totalGoals} |\n`;
  markdown += `| Achieved | ${achievedGoals} |\n`;
  markdown += `| At Risk / Behind | ${atRiskGoals} |\n`;
  markdown += `| Average Progress | ${avgProgress.toFixed(1)}% |\n\n`;

  // Batch-load all key results for the goals in a single query
  const goalIds = goals.map((g) => g.id);
  const allKrs = goalIds.length > 0
    ? await db.select().from(bearingKeyResults).where(inArray(bearingKeyResults.goal_id, goalIds))
    : [];
  const krsByGoal = groupKrsByGoal(allKrs as any);

  // Goals detail
  markdown += `## Goals\n\n`;
  for (const goal of goals) {
    markdown += `### ${goal.title}\n\n`;
    markdown += `- **Status:** ${goal.status}\n`;
    markdown += `- **Progress:** ${goal.progress}%\n`;
    markdown += `- **Scope:** ${goal.scope}\n`;
    if (goal.description) {
      markdown += `- **Description:** ${goal.description}\n`;
    }

    const krs = (krsByGoal.get(goal.id) ?? []) as any[];

    if (krs.length > 0) {
      markdown += `\n**Key Results:**\n\n`;
      for (const kr of krs) {
        markdown += `- ${kr.title}: ${kr.current_value}/${kr.target_value} ${kr.unit ?? ''} (${kr.progress}%)\n`;
      }
    }
    markdown += `\n`;
  }

  return {
    format: 'markdown',
    content: markdown,
    generated_at: new Date().toISOString(),
    period_id: periodId,
  };
}

/**
 * Generate an at-risk goals report.
 */
export async function generateAtRiskReport(orgId: string) {
  const goals = await db
    .select()
    .from(bearingGoals)
    .where(
      and(
        eq(bearingGoals.organization_id, orgId),
        or(
          eq(bearingGoals.status, 'at_risk'),
          eq(bearingGoals.status, 'behind'),
        ),
      ),
    )
    .limit(500);

  let markdown = `# At-Risk Goals Report\n\n`;
  markdown += `**Generated:** ${new Date().toISOString()}  \n`;
  markdown += `**Total at-risk goals:** ${goals.length}  \n\n`;

  if (goals.length === 0) {
    markdown += `No goals are currently at risk. Great work!\n`;
  } else {
    // Batch-load all key results for at-risk goals
    const atRiskGoalIds = goals.map((g) => g.id);
    const allAtRiskKrs = atRiskGoalIds.length > 0
      ? await db.select().from(bearingKeyResults).where(inArray(bearingKeyResults.goal_id, atRiskGoalIds))
      : [];
    const atRiskKrsByGoal = groupKrsByGoal(allAtRiskKrs as any);

    for (const goal of goals) {
      markdown += `### ${goal.title}\n\n`;
      markdown += `- **Status:** ${goal.status}\n`;
      markdown += `- **Progress:** ${goal.progress}%\n`;
      markdown += `- **Period:** ${goal.period_id}\n`;
      if (goal.description) {
        markdown += `- **Description:** ${goal.description}\n`;
      }

      const krs = (atRiskKrsByGoal.get(goal.id) ?? []) as any[];

      if (krs.length > 0) {
        markdown += `\n**Key Results:**\n\n`;
        for (const kr of krs) {
          const behindMarker = parseFloat(kr.progress) < 50 ? ' :warning:' : '';
          markdown += `- ${kr.title}: ${kr.progress}%${behindMarker}\n`;
        }
      }
      markdown += `\n`;
    }
  }

  return {
    format: 'markdown',
    content: markdown,
    generated_at: new Date().toISOString(),
  };
}

/**
 * Generate a report for a specific user's goals across periods.
 */
export async function generateOwnerReport(userId: string, orgId: string) {
  const goals = await db
    .select()
    .from(bearingGoals)
    .where(
      and(
        eq(bearingGoals.organization_id, orgId),
        eq(bearingGoals.owner_id, userId),
      ),
    )
    .limit(500);

  let markdown = `# Goals Report for Owner\n\n`;
  markdown += `**Generated:** ${new Date().toISOString()}  \n`;
  markdown += `**Total goals:** ${goals.length}  \n\n`;

  // Batch-load all key results and periods for owner goals
  const ownerGoalIds = goals.map((g) => g.id);
  const allOwnerKrs = ownerGoalIds.length > 0
    ? await db.select().from(bearingKeyResults).where(inArray(bearingKeyResults.goal_id, ownerGoalIds))
    : [];
  const ownerKrsByGoal = groupKrsByGoal(allOwnerKrs as any);

  // Group by period
  const byPeriod = new Map<string, typeof goals>();
  for (const goal of goals) {
    const periodGoals = byPeriod.get(goal.period_id) ?? [];
    periodGoals.push(goal);
    byPeriod.set(goal.period_id, periodGoals);
  }

  // Batch-load all referenced periods
  const periodIds = [...byPeriod.keys()];
  const allPeriods = periodIds.length > 0
    ? await db.select().from(bearingPeriods).where(inArray(bearingPeriods.id, periodIds))
    : [];
  const periodMap = new Map(allPeriods.map((p) => [p.id, p]));

  for (const [periodId, periodGoals] of byPeriod) {
    const period = periodMap.get(periodId);

    markdown += `## ${period?.name ?? periodId}\n\n`;

    for (const goal of periodGoals) {
      markdown += `### ${goal.title}\n\n`;
      markdown += `- **Status:** ${goal.status}\n`;
      markdown += `- **Progress:** ${goal.progress}%\n`;

      const krs = (ownerKrsByGoal.get(goal.id) ?? []) as any[];

      if (krs.length > 0) {
        markdown += `\n**Key Results:**\n\n`;
        for (const kr of krs) {
          markdown += `- ${kr.title}: ${kr.current_value}/${kr.target_value} ${kr.unit ?? ''} (${kr.progress}%)\n`;
        }
      }
      markdown += `\n`;
    }
  }

  return {
    format: 'markdown',
    content: markdown,
    generated_at: new Date().toISOString(),
    owner_id: userId,
  };
}
