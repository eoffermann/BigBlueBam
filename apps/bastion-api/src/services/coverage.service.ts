// Readiness and the Evidence map (spec 2.3, 6.1; 5.1 rows 50 and 94). Both read the ONE loader in
// engine/numbers.ts, so the four numbers, the per-control columns and readiness.weekly agree.
//
//   GET /summary   the four numbers, "Not set up yet", the denominator sentence, the framework
//                  view and days to audit, banners, top stored gaps, evidence expiring soon.
//   GET /coverage  every in-view control by source column (native, feed, uploaded, self-attested).

import {
  BASTION_DAY_MS as DAY_MS,
  BASTION_PENDING_SCAN_CAP_MS,
  type BastionCoverageResponse,
  type BastionFixTemplate,
  type BastionFrameworkStatus,
  type BastionGapKind,
  type BastionReadinessBanner,
  type BastionSummaryResponse,
} from '@bigbluebam/shared';
import type { Served } from '../lib/served.js';
import { NotFoundError } from '../lib/errors.js';
import { type EngineDeps, orgTx } from '../engine/context.js';
import { daysLeft } from '../engine/manual.js';
import { complianceProjectHealth, complianceProjectProblem } from '../engine/remediation.js';
import { computeNumbers, coverageOfColumns, loadControlStates, type ReadinessNumbers } from '../engine/numbers.js';
import type { Viewer } from './types.js';

export interface PlatformFacts {
  /** The boot bucket check outcome (spec 9.1). */
  storage_ok: boolean;
  /** BASTION_BACKUP_S3_* configured (spec 9.7). */
  offsite_backup_configured: boolean;
}

const STATE_WORDS: Record<string, string> = {
  pass: 'Proven',
  pass_with_exception: 'Not met, risk accepted',
  fail: 'Not met',
  unprovable: "Can't prove yet",
};

/** One sentence per "can't prove" reason (spec 3.2), shared with the auditor room and the packet. */
export const REASON_WORDS: Record<string, string> = {
  not_yet_confirmed: 'Nobody has confirmed how to check this yet.',
  no_evidence_source: 'Nothing in the suite can show this. Upload evidence or connect a source.',
  source_not_connected: "This could be checked automatically, but the source isn't connected.",
  manual_evidence_missing: 'Waiting for someone to upload the evidence this needs.',
  manual_evidence_expired: 'The evidence that was uploaded has expired.',
  insufficient_data: "There wasn't enough activity in the period to tell.",
  probe_error: "The check couldn't run. We'll try again tonight.",
  evaluation_stale: "This hasn't been checked recently, so we can't vouch for it.",
};

/** "41 of 64 controls checked; 23 not set up yet" (spec 2.3: the headline carries its denominator). */
export function denominatorSentence(n: ReadinessNumbers): string {
  const base = `${n.checked} of ${n.total} control${n.total === 1 ? '' : 's'} checked`;
  return n.not_set_up > 0 ? `${base}; ${n.not_set_up} not set up yet` : base;
}

async function frameworkView(tx: EngineDeps['sql'], orgId: string, frameworkId: string | undefined, now: Date) {
  const frameworks = await tx`
    SELECT id, template_key, name, status, audit_target_date::text AS audit_target_date
      FROM bastion_frameworks WHERE organization_id = ${orgId} AND status <> 'archived' ORDER BY created_at`;
  if (frameworkId && !frameworks.some((f) => f.id === frameworkId)) throw new NotFoundError('We could not find that framework.');
  const inView = frameworkId ? frameworks.filter((f) => f.id === frameworkId) : frameworks;
  const targets = inView.map((f) => f.audit_target_date as string | null).filter((d): d is string => !!d);
  const nearest = targets.sort()[0] ?? null;
  const daysToAudit = nearest ? Math.ceil((Date.parse(`${nearest}T00:00:00Z`) - now.getTime()) / DAY_MS) : null;
  const option = (f: (typeof frameworks)[number]) => ({
    id: String(f.id),
    template_key: String(f.template_key),
    name: String(f.name),
    audit_target_date: (f.audit_target_date as string | null) ?? null,
  });
  const selected = frameworkId ? frameworks.find((f) => f.id === frameworkId) : undefined;
  return {
    frameworks: frameworks.map(option),
    selected: selected ? { ...option(selected), status: selected.status as BastionFrameworkStatus } : null,
    nearest_audit_date: nearest,
    days_to_audit: daysToAudit,
  };
}

/** GET /summary (row 94) and the Readiness page. */
export async function readinessSummary(
  engine: EngineDeps,
  viewer: Viewer,
  frameworkId: string | undefined,
  facts: PlatformFacts,
): Promise<Served<BastionSummaryResponse>> {
  const now = engine.now();
  return orgTx(engine.sql, viewer.org_id, async (tx) => {
    const view = await frameworkView(tx, viewer.org_id, frameworkId, now);
    const states = await loadControlStates(tx, viewer.org_id, now, frameworkId);
    const numbers = computeNumbers(states.controls, states.exceptions, states.stale_after_hours, now);
    const settings = (await tx`SELECT compliance_project_id, stale_after_hours, manual_expiry_warn_days, timezone
                                 FROM bastion_org_settings WHERE organization_id = ${viewer.org_id}`)[0];
    const facts2 = (await tx`
      SELECT (SELECT count(*)::int FROM bastion_manual_evidence WHERE organization_id = ${viewer.org_id} AND status = 'active' AND scan_label = 'not_scanned') AS not_scanned,
             (SELECT count(*)::int FROM bastion_manual_evidence WHERE organization_id = ${viewer.org_id} AND status = 'pending_scan'
                AND created_at <= ${new Date(now.getTime() - BASTION_PENDING_SCAN_CAP_MS)}) AS stuck_scans,
             (SELECT count(*)::int FROM bastion_ledger_restores WHERE organization_id = ${viewer.org_id} AND resolution IS NULL) AS restores_pending,
             (SELECT count(*)::int FROM bastion_outbox WHERE organization_id = ${viewer.org_id} AND status = 'dead') AS dead_deliveries,
             (SELECT max(completed_at) FROM bastion_evaluation_runs WHERE organization_id = ${viewer.org_id} AND status = 'succeeded' AND scope = 'all') AS last_full_run`)[0] ?? {};
    const staleMs = Number(settings?.stale_after_hours ?? 36) * 3_600_000;
    const setUp = states.controls.filter((c) => c.confirmed_count > 0);
    const staleControls = setUp.filter((c) => !c.last_evaluated_at || now.getTime() - c.last_evaluated_at.getTime() > staleMs).length;

    const banners: Array<{ code: BastionReadinessBanner; message: string; count?: number }> = [];
    if (!settings?.compliance_project_id) {
      banners.push({ code: 'no_compliance_project', message: 'Pick a Compliance project in Setup so Bastion can file tasks when a control needs attention.' });
    } else {
      // #229: set, but deleted or with no open phase, the api refuses every task.
      const problem = complianceProjectProblem(await complianceProjectHealth(tx, viewer.org_id, settings.compliance_project_id as string));
      if (problem) banners.push({ code: 'compliance_project_unavailable', message: problem });
    }
    if (staleControls > 0) {
      const when = facts2.last_full_run ? new Date(facts2.last_full_run as string).toISOString().slice(0, 10) : null;
      banners.push({
        code: 'checks_stale',
        count: staleControls,
        message: when
          ? `${staleControls} control${staleControls === 1 ? " hasn't" : "s haven't"} been checked since ${when}, so Bastion can't vouch for ${staleControls === 1 ? 'it' : 'them'}.`
          : `${staleControls} control${staleControls === 1 ? " hasn't" : "s haven't"} been checked yet. The first nightly check fills these in.`,
      });
    }
    if (Number(facts2.not_scanned) > 0) {
      banners.push({ code: 'scanning_off', count: Number(facts2.not_scanned), message: 'Some uploads were not virus-scanned, because scanning is off on this installation.' });
    }
    if (!facts.storage_ok) {
      banners.push({ code: 'storage_not_set_up', message: "Evidence storage isn't working, so new evidence can't be saved. Ask whoever runs this installation to check it." });
    }
    if (!facts.offsite_backup_configured) {
      banners.push({ code: 'offsite_backup_not_configured', message: 'Evidence files have no off-site backup yet. Ask whoever runs this installation to set one up.' });
    }
    if (Number(facts2.restores_pending) > 0) {
      banners.push({ code: 'restore_pending', count: Number(facts2.restores_pending), message: 'Evidence recording is paused until an owner looks at a gap in the evidence history (Settings, Evidence integrity).' });
    }
    if (Number(facts2.dead_deliveries) > 0) {
      banners.push({ code: 'delivery_problems', count: Number(facts2.dead_deliveries), message: `${facts2.dead_deliveries} update${Number(facts2.dead_deliveries) === 1 ? '' : 's'} to other apps could not be delivered (Settings, Delivery problems).` });
    }
    if (Number(facts2.stuck_scans) > 0) {
      banners.push({ code: 'stuck_scans', count: Number(facts2.stuck_scans), message: `${facts2.stuck_scans} upload${Number(facts2.stuck_scans) === 1 ? ' has' : 's have'} waited more than a day for a virus scan. You can check again from the Evidence locker.` });
    }

    const topGaps = await tx`
      SELECT g.id, g.control_id, c.title AS control_title, g.gap_kind, g.risk_score, g.fix_template, g.fix_cost
        FROM bastion_gaps g JOIN bastion_controls c ON c.id = g.control_id AND c.organization_id = g.organization_id
       WHERE g.organization_id = ${viewer.org_id} AND g.status = 'open'
         ${frameworkId ? tx`AND g.control_id = ANY(${states.controls.map((c) => c.control_id)}::uuid[])` : tx``}
       ORDER BY g.risk_score DESC, g.fix_cost ASC LIMIT 5`;

    const warnDays = Number(settings?.manual_expiry_warn_days ?? 30);
    const expiring = await tx`
      SELECT e.id, e.title, e.sensitivity, e.valid_until, u.display_name AS owner_name
        FROM bastion_manual_evidence e LEFT JOIN users u ON u.id = e.owner_user_id
       WHERE e.organization_id = ${viewer.org_id} AND e.status = 'active' AND e.valid_until IS NOT NULL
         AND e.valid_until > ${now} AND e.valid_until <= ${new Date(now.getTime() + warnDays * DAY_MS)}
       ORDER BY e.valid_until LIMIT 10`;

    return {
      data: {
        ...view,
        numbers,
        headline: denominatorSentence(numbers),
        not_met_label: numbers.risk_accepted > 0 ? `Not met: ${numbers.not_met} (${numbers.risk_accepted} risk accepted)` : `Not met: ${numbers.not_met}`,
        not_applicable: states.not_applicable,
        banners,
        top_gaps: topGaps.map((g) => ({
          id: String(g.id),
          control_id: String(g.control_id),
          control_title: String(g.control_title),
          gap_kind: g.gap_kind as BastionGapKind,
          risk_score: Number(g.risk_score),
          fix_template: (g.fix_template as BastionFixTemplate | null) ?? null,
          fix_cost: g.fix_cost === null || g.fix_cost === undefined ? null : Number(g.fix_cost),
        })),
        gaps_ranked: topGaps.length > 0,
        expiring_evidence: expiring.map((e) => ({
          id: String(e.id),
          title: e.sensitivity === 'restricted' ? 'Restricted evidence' : String(e.title),
          owner_name: (e.owner_name as string | null) ?? null,
          valid_until: e.valid_until as Date,
          days_left: daysLeft(new Date(e.valid_until as string), now),
        })),
        last_full_run_at: (facts2.last_full_run as Date | null | undefined) ?? null,
        timezone: String(settings?.timezone ?? 'UTC'),
        as_of: now.toISOString(),
      },
    };
  });
}

/** GET /coverage (row 50): the Evidence map. */
export async function coverageMap(engine: EngineDeps, viewer: Viewer, frameworkId: string | undefined): Promise<Served<BastionCoverageResponse>> {
  const now = engine.now();
  return orgTx(engine.sql, viewer.org_id, async (tx) => {
    const view = await frameworkView(tx, viewer.org_id, frameworkId, now);
    const states = await loadControlStates(tx, viewer.org_id, now, frameworkId);
    const numbers = computeNumbers(states.controls, states.exceptions, states.stale_after_hours, now);
    const rows = states.controls.map((c) => ({
      control_id: c.control_id,
      control_key: c.control_key,
      title: c.title,
      category: c.category,
      owner_name: c.owner_name,
      set_up: c.confirmed_count > 0,
      bucket: c.verdict.bucket,
      state: c.verdict.state,
      state_words: c.verdict.state ? (STATE_WORDS[c.verdict.state] ?? c.verdict.state) : 'Not set up yet',
      reason: c.verdict.reason,
      reason_words: c.verdict.reason ? (REASON_WORDS[c.verdict.reason] ?? null) : null,
      risk_accepted: c.verdict.risk_accepted,
      columns: c.columns,
      coverage_kind: coverageOfColumns(c.columns),
      manual_expires_at: c.manual_expires_at ? c.manual_expires_at.toISOString() : null,
      manual_days_left: c.manual_expires_at ? daysLeft(c.manual_expires_at, now) : null,
      last_evaluated_at: c.last_evaluated_at ? c.last_evaluated_at.toISOString() : null,
    }));
    const totals = {
      native: rows.filter((r) => r.columns.native > 0).length,
      feed: rows.filter((r) => r.columns.feed > 0).length,
      manual_file: rows.filter((r) => r.columns.manual_file > 0).length,
      self_attested: rows.filter((r) => r.columns.self_attested > 0).length,
      none: rows.filter((r) => !r.set_up).length,
    };
    return { data: rows, totals, numbers, headline: denominatorSentence(numbers), not_applicable: states.not_applicable, frameworks: view.frameworks };
  });
}
