// Gap ranking (spec 2.3): the ONE implementation of the (status, reason) -> gap_kind -> severity
// -> fix template table. computeGaps is pure (unit-tested case by case); gapRank recomputes the
// stored bastion_gaps rows for each org (the bastion-gap-rank engine: after each run and daily).
//
// Gaps are computed per assertion from effectiveStatus's per-assertion states, so an accepted
// exception removes only the covered assertion's `failing` gap and a sibling's `manual_missing`
// gap stays on the list (spec 3.2). Staleness is NOT a per-control gap: stored gaps reflect the
// last known outcome, and "checks are stale" is one org-level row derived at read time
// (staleGapRow), never stored.

import {
  BASTION_FIX_TEMPLATE_COST,
  BASTION_GAP_SEVERITY,
  BASTION_POPULATION_REVIEW_COST,
  BASTION_POPULATION_REVIEW_DAYS,
  type BastionFixTemplate,
  type BastionGapKind,
} from '@bigbluebam/shared';
import { failingTemplate, TEMPLATE_BY_GAP_KIND } from '../library/fix-templates.js';
import { type EngineDeps, orgTx, sqlstateOf, type Tx, utcDate } from './context.js';
import { UnavailableError } from '../lib/errors.js';
import { GAP_RANK_LOCK_TIMEOUT_MS } from './budgets.js';
import { type CitedRef, effectiveStatus, type ExceptionRow } from './status.js';

const DAY_MS = 86_400_000;
/** effectiveStatus with staleness switched off: stored gaps describe the last known outcome. */
const NEVER_STALE_HOURS = 1e9;

export interface GapAssertion {
  assertion_id: string;
  kind: 'probe' | 'manual' | 'feed';
  manual_kind: string | null;
  probe_key: string | null;
  outcome: 'pass' | 'fail' | 'unprovable';
  unprovable_reason: string | null;
  cited_refs: CitedRef[];
  /** Population probes only: members found but not in the confirmed list (spec 3.1). */
  population_unlisted: unknown[] | null;
  /** Population probes only: when a person last confirmed the list. */
  population_confirmed_at: Date | null;
  is_population: boolean;
  /** Manual checks: when the accepted evidence expires (from the snapshot summary). */
  expires_at: Date | null;
}

export interface GapControl {
  control_id: string;
  risk_weight: number;
  consecutive_error_nights: number;
  /** Every assertion on the control, whatever its review status. */
  assertion_count: number;
  rejected_count: number;
  confirmed_count: number;
  /** Earliest adoption among the live frameworks that link the control. */
  adopted_at: Date | null;
  /** Confirmed assertions that have a snapshot. */
  assertions: GapAssertion[];
}

export interface GapSettings {
  warn_days: number;
  grace_days: number;
  /** Days to the nearest audit target date, null when none is set. */
  days_to_audit: number | null;
}

export interface GapCandidate {
  control_id: string;
  assertion_id: string | null;
  gap_kind: BastionGapKind;
  severity: number;
  fix_template: BastionFixTemplate | null;
  fix_cost: number | null;
  risk_score: number;
}

/** audit_proximity = 1 + max(0, 90 - days_to_nearest_audit_target) / 90, capped at 2. */
export function auditProximity(daysToAudit: number | null): number {
  if (daysToAudit === null) return 1;
  return 1 + Math.min(90, Math.max(0, 90 - daysToAudit)) / 90;
}

export function costOf(kind: BastionGapKind, template: BastionFixTemplate | null): number | null {
  if (kind === 'population_review') return BASTION_POPULATION_REVIEW_COST;
  return template ? BASTION_FIX_TEMPLATE_COST[template] : null;
}

const UNPROVABLE_KIND: Record<string, BastionGapKind> = {
  no_evidence_source: 'no_source',
  manual_evidence_expired: 'manual_expired',
  source_not_connected: 'not_connected',
  manual_evidence_missing: 'manual_missing',
  insufficient_data: 'insufficient_data',
  probe_error: 'check_broken',
};

const isSelfAttested = (a: GapAssertion) => a.kind === 'manual' && a.manual_kind === 'attestation_statement';

export function computeGaps(controls: GapControl[], exceptions: ExceptionRow[], settings: GapSettings, now: Date): GapCandidate[] {
  const out: GapCandidate[] = [];
  const proximity = auditProximity(settings.days_to_audit);
  const push = (c: GapControl, assertionId: string | null, kind: BastionGapKind, severity: number, template: BastionFixTemplate | null) => {
    out.push({
      control_id: c.control_id,
      assertion_id: assertionId,
      gap_kind: kind,
      severity,
      fix_template: template,
      fix_cost: costOf(kind, template),
      risk_score: Math.round(c.risk_weight * severity * proximity * 10_000) / 10_000,
    });
  };
  const fixed = (kind: Exclude<BastionGapKind, 'failing' | 'manual_expiring'>) => BASTION_GAP_SEVERITY[kind] ?? 0;

  for (const c of controls) {
    const mine = exceptions.filter((e) => e.control_id === undefined || e.control_id === c.control_id);

    if (c.confirmed_count === 0) {
      // Every assertion rejected: no grace (somebody looked and said no to every check).
      const allRejected = c.assertion_count > 0 && c.rejected_count === c.assertion_count;
      const pastGrace = !!c.adopted_at && now.getTime() - c.adopted_at.getTime() > settings.grace_days * DAY_MS;
      if (allRejected || pastGrace) push(c, null, 'not_assessed', fixed('not_assessed'), TEMPLATE_BY_GAP_KIND.not_assessed);
      continue;
    }

    for (const a of c.assertions) {
      const eff = effectiveStatus(
        { last_evaluated_at: now, stale_after_hours: NEVER_STALE_HOURS, assertions: [a], exceptions: mine },
        now,
      );
      const state = eff.assertions[0]?.state ?? eff.state;
      if (state === 'fail') {
        push(c, a.assertion_id, 'failing', BASTION_GAP_SEVERITY.failing ?? 1, failingTemplate(a.kind, a.probe_key));
      } else if (state === 'unprovable') {
        const kind = UNPROVABLE_KIND[a.unprovable_reason ?? ''];
        // A probe_error is an infrastructure problem until the second distinct night (spec 3.2).
        if (kind && !(kind === 'check_broken' && c.consecutive_error_nights < 2)) {
          push(c, a.assertion_id, kind, fixed(kind as Exclude<BastionGapKind, 'failing' | 'manual_expiring'>), TEMPLATE_BY_GAP_KIND[kind as Exclude<BastionGapKind, 'failing'>]);
        }
      } else if (state === 'pass' && a.kind === 'manual' && a.expires_at) {
        const daysLeft = (a.expires_at.getTime() - now.getTime()) / DAY_MS;
        if (daysLeft > 0 && daysLeft <= settings.warn_days) {
          const severity = Math.round(0.5 * (1 - daysLeft / settings.warn_days) * 10_000) / 10_000;
          push(c, a.assertion_id, 'manual_expiring', severity, TEMPLATE_BY_GAP_KIND.manual_expiring);
        }
      }
      // pass_with_exception: no gap; the exception is listed under "Accepted risks".

      if (a.is_population) {
        if ((a.population_unlisted ?? []).length > 0) {
          push(c, a.assertion_id, 'population_drift', fixed('population_drift'), TEMPLATE_BY_GAP_KIND.population_drift);
        }
        if (a.population_confirmed_at && now.getTime() - a.population_confirmed_at.getTime() > BASTION_POPULATION_REVIEW_DAYS * DAY_MS) {
          push(c, a.assertion_id, 'population_review', fixed('population_review'), TEMPLATE_BY_GAP_KIND.population_review);
        }
      }
    }

    // Effective pass resting only on people's written statements.
    if (c.assertions.length > 0 && c.assertions.length === c.confirmed_count && c.assertions.every(isSelfAttested)) {
      const all = effectiveStatus({ last_evaluated_at: now, stale_after_hours: NEVER_STALE_HOURS, assertions: c.assertions, exceptions: mine }, now);
      if (all.state === 'pass') {
        for (const a of c.assertions) push(c, a.assertion_id, 'attested_only', fixed('attested_only'), TEMPLATE_BY_GAP_KIND.attested_only);
      }
    }
  }
  return out;
}

/** Sort for "What to fix first": risk descending, cost ascending. "Quick wins": risk / cost. */
export function sortGaps<T extends { risk_score: number; fix_cost: number | null }>(rows: T[], mode: 'risk' | 'quick_wins'): T[] {
  const cost = (r: T) => r.fix_cost ?? 99;
  return [...rows].sort((a, b) =>
    mode === 'quick_wins'
      ? b.risk_score / cost(b) - a.risk_score / cost(a) || b.risk_score - a.risk_score
      : b.risk_score - a.risk_score || cost(a) - cost(b),
  );
}

// ── Loading and storing ─────────────────────────────────────────────────────────────────

export async function loadGapInputs(tx: Tx, orgId: string, now: Date): Promise<{ controls: GapControl[]; exceptions: ExceptionRow[]; settings: GapSettings }> {
  const s = (await tx`SELECT manual_expiry_warn_days, not_assessed_grace_days FROM bastion_org_settings WHERE organization_id = ${orgId}`)[0];
  const target = (
    await tx`SELECT min(audit_target_date)::text AS d FROM bastion_frameworks
              WHERE organization_id = ${orgId} AND status <> 'archived' AND audit_target_date IS NOT NULL`
  )[0]?.d as string | null;
  const daysToAudit = target ? Math.ceil((Date.parse(`${target}T00:00:00Z`) - now.getTime()) / DAY_MS) : null;

  const controls = await tx`
    SELECT c.id, c.risk_weight, c.consecutive_error_nights,
           (SELECT min(f.adopted_at) FROM bastion_control_requirements r
              JOIN bastion_frameworks f ON f.id = r.framework_id AND f.organization_id = r.organization_id
             WHERE r.organization_id = c.organization_id AND r.control_id = c.id AND r.removed_at IS NULL
               AND f.status <> 'archived') AS adopted_at,
           (SELECT count(*)::int FROM bastion_assertions a WHERE a.organization_id = c.organization_id AND a.control_id = c.id
               AND a.review_status <> 'superseded') AS assertion_count,
           (SELECT count(*)::int FROM bastion_assertions a WHERE a.organization_id = c.organization_id AND a.control_id = c.id
               AND a.review_status = 'rejected') AS rejected_count,
           (SELECT count(*)::int FROM bastion_assertions a WHERE a.organization_id = c.organization_id AND a.control_id = c.id
               AND a.review_status = 'confirmed') AS confirmed_count
      FROM bastion_controls c
     WHERE c.organization_id = ${orgId} AND c.lifecycle = 'active'
       AND EXISTS (SELECT 1 FROM bastion_control_requirements r
                     JOIN bastion_frameworks f ON f.id = r.framework_id AND f.organization_id = r.organization_id
                    WHERE r.organization_id = c.organization_id AND r.control_id = c.id AND r.removed_at IS NULL
                      AND r.applicability = 'applicable' AND f.status <> 'archived')`;
  const latest = await tx`
    SELECT a.id AS assertion_id, a.control_id, a.kind, a.probe_key, a.manual_evidence_spec->>'kind' AS manual_kind,
           a.params->'expected_population' AS expected_population, a.params->>'population_confirmed_at' AS population_confirmed_at,
           s.outcome, s.unprovable_reason, s.cited_refs, s.population_unlisted, s.summary
      FROM bastion_assertions a
      JOIN LATERAL (
        SELECT outcome, unprovable_reason, cited_refs, population_unlisted, summary FROM bastion_evidence_snapshots s
         WHERE s.organization_id = a.organization_id AND s.assertion_id = a.id
         ORDER BY s.created_at DESC LIMIT 1) s ON true
     WHERE a.organization_id = ${orgId} AND a.review_status = 'confirmed'`;
  const exRows = await tx`
    SELECT id, control_id, scope, assertion_id, cited_entity_type, cited_entity_id, frozen_refs, status, expires_at
      FROM bastion_exceptions WHERE organization_id = ${orgId} AND status = 'active'`;

  const byId = new Map<string, GapControl>();
  for (const c of controls) {
    byId.set(String(c.id), {
      control_id: String(c.id),
      risk_weight: Number(c.risk_weight ?? 3),
      consecutive_error_nights: Number(c.consecutive_error_nights ?? 0),
      assertion_count: Number(c.assertion_count),
      rejected_count: Number(c.rejected_count),
      confirmed_count: Number(c.confirmed_count),
      adopted_at: c.adopted_at ? new Date(c.adopted_at as string) : null,
      assertions: [],
    });
  }
  for (const a of latest) {
    const c = byId.get(String(a.control_id));
    if (!c) continue;
    const exp = (a.summary as Record<string, unknown> | null)?.expires_at;
    c.assertions.push({
      assertion_id: String(a.assertion_id),
      kind: a.kind as GapAssertion['kind'],
      manual_kind: (a.manual_kind as string | null) ?? null,
      probe_key: (a.probe_key as string | null) ?? null,
      outcome: a.outcome as GapAssertion['outcome'],
      unprovable_reason: (a.unprovable_reason as string | null) ?? null,
      cited_refs: (a.cited_refs as CitedRef[]) ?? [],
      population_unlisted: (a.population_unlisted as unknown[] | null) ?? null,
      population_confirmed_at: a.population_confirmed_at ? new Date(a.population_confirmed_at as string) : null,
      is_population: Array.isArray(a.expected_population),
      expires_at: typeof exp === 'string' ? new Date(exp) : null,
    });
  }
  const exceptions: ExceptionRow[] = exRows.map((e) => ({
    id: String(e.id),
    control_id: String(e.control_id),
    scope: e.scope as 'entity' | 'assertion',
    assertion_id: (e.assertion_id as string | null) ?? null,
    cited_entity_type: (e.cited_entity_type as string | null) ?? null,
    cited_entity_id: (e.cited_entity_id as string | null) ?? null,
    frozen_refs: (e.frozen_refs as CitedRef[] | null) ?? null,
    status: String(e.status),
    expires_at: new Date(e.expires_at as string),
  }));
  return {
    controls: [...byId.values()],
    exceptions,
    settings: { warn_days: Number(s?.manual_expiry_warn_days ?? 30), grace_days: Number(s?.not_assessed_grace_days ?? 14), days_to_audit: daysToAudit },
  };
}

export interface GapRankOrgResult {
  open: number;
  inserted: number;
  reopened: number;
  resolved: number;
}

/**
 * The per-org gap-ranking lock (#230), transaction-scoped. Every re-rank (the daily pass, the
 * post-run pass, exception approval, exception expiry) takes it before reading, so passes for one
 * org run one at a time and each reads what the previous one committed: an older read can never
 * commit last, and two passes never lock the same gap rows in opposite orders. A caller that also
 * takes other locks (exception approval takes the ledger's) takes this one FIRST, so the order is
 * always gap-rank lock, then everything else. Re-entrant within one transaction.
 *
 * Holders never make network calls while holding it (#293): a caller that needs can_access
 * verdicts takes them first, then the lock, then re-validates cheaply. A waiter gives up after
 * GAP_RANK_LOCK_TIMEOUT_MS with GapRankBusyError (503, "try again in a moment") instead of pinning
 * a pool connection behind a slow holder; the transaction's previous lock_timeout is restored once
 * the lock is held, so later row locks in it keep their own rules.
 */
export async function lockOrgGapRank(tx: Tx, orgId: string): Promise<void> {
  const prev = String((await tx`SELECT current_setting('lock_timeout') AS v`)[0]?.v ?? '0');
  await tx`SELECT set_config('lock_timeout', ${`${GAP_RANK_LOCK_TIMEOUT_MS}ms`}, true)`;
  try {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`bastion_gap_rank:${orgId}`}, 0))`;
  } catch (err) {
    if (sqlstateOf(err) === '55P03') throw new GapRankBusyError();
    throw err;
  }
  await tx`SELECT set_config('lock_timeout', ${prev}, true)`;
}

/** A gap writer waited GAP_RANK_LOCK_TIMEOUT_MS for another one in the same org (#293). */
export class GapRankBusyError extends UnavailableError {
  constructor() {
    super('Bastion is busy updating this organization\'s gaps. Try again in a moment.', 'GAP_RANK_BUSY');
    this.name = 'GapRankBusyError';
  }
}

/** As lockOrgGapRank, but answers false at once when another pass holds it. */
async function tryLockOrgGapRank(tx: Tx, orgId: string): Promise<boolean> {
  const r = await tx`SELECT pg_try_advisory_xact_lock(hashtextextended(${`bastion_gap_rank:${orgId}`}, 0)) AS ok`;
  return r[0]?.ok === true;
}

/**
 * Reconcile the stored gaps of one org inside the caller's transaction: new gaps are inserted
 * `open`; a `resolved` gap that comes back reopens; `open`/`proposed`/`dismissed` keep their status
 * and get the new score; a gap that is no longer present and was `open` or `proposed` resolves.
 * Serialized per org by lockOrgGapRank, taken before the inputs are read.
 */
export async function rankOrgGaps(tx: Tx, orgId: string, now: Date): Promise<GapRankOrgResult> {
  await lockOrgGapRank(tx, orgId);
  return rankOrgGapsLocked(tx, orgId, now);
}

async function rankOrgGapsLocked(tx: Tx, orgId: string, now: Date): Promise<GapRankOrgResult> {
  const input = await loadGapInputs(tx, orgId, now);
  const candidates = computeGaps(input.controls, input.exceptions, input.settings, now);
  const existing = await tx`SELECT id, control_id, assertion_id, gap_kind, status FROM bastion_gaps WHERE organization_id = ${orgId}`;
  const key = (c: { [k: string]: unknown } | GapCandidate) => `${String(c.control_id)}|${String(c.assertion_id ?? '')}|${String(c.gap_kind)}`;
  const byKey = new Map(existing.map((e) => [key(e), e]));
  const r: GapRankOrgResult = { open: 0, inserted: 0, reopened: 0, resolved: 0 };
  const seen = new Set<string>();
  for (const g of candidates) {
    const k = key(g);
    if (seen.has(k)) continue;
    seen.add(k);
    const cur = byKey.get(k);
    if (!cur) {
      await tx`
        INSERT INTO bastion_gaps (organization_id, control_id, assertion_id, gap_kind, risk_score, fix_template, fix_cost, status, computed_at)
        VALUES (${orgId}, ${g.control_id}, ${g.assertion_id}, ${g.gap_kind}, ${g.risk_score}, ${g.fix_template}, ${g.fix_cost}, 'open', ${now})
        ON CONFLICT (organization_id, control_id, assertion_id, gap_kind) DO NOTHING`;
      r.inserted += 1;
      r.open += 1;
      continue;
    }
    const reopen = cur.status === 'resolved';
    await tx`
      UPDATE bastion_gaps SET risk_score = ${g.risk_score}, fix_template = ${g.fix_template}, fix_cost = ${g.fix_cost}, computed_at = ${now},
             status = CASE WHEN status = 'resolved' THEN 'open' ELSE status END,
             dismissed_reason = CASE WHEN status = 'resolved' THEN NULL ELSE dismissed_reason END
       WHERE id = ${cur.id as string}`;
    if (reopen) r.reopened += 1;
    if (reopen || cur.status === 'open' || cur.status === 'proposed') r.open += 1;
  }
  for (const e of existing) {
    if (seen.has(key(e))) continue;
    if (e.status === 'open' || e.status === 'proposed') {
      await tx`UPDATE bastion_gaps SET status = 'resolved', computed_at = ${now} WHERE id = ${e.id as string}`;
      r.resolved += 1;
    }
  }
  return r;
}

/**
 * The all-org pass stops after this long and resumes from a cursor on the next call (#230), so
 * one request always answers well inside the worker's 30 s engine timeout and a timed-out job can
 * never leave a second full pass running behind its retry.
 */
export const GAP_RANK_BUDGET_MS = 20_000;
const GAP_RANK_CURSOR = 'bastion:gap-rank:all';

/**
 * The bastion-gap-rank engine (spec 7). With organization_id (the post-run pass): that org,
 * waiting for any pass already ranking it so this one reads what it committed. Without (the daily
 * pass): every org with Bastion set up in id order, one transaction each, from the resume cursor,
 * until GAP_RANK_BUDGET_MS; an org another pass is ranking right now is skipped (that pass is
 * already doing it). `complete: false` means call again to continue (the worker does).
 */
/** The resume cursor of one daily pass (#256): which pass it belongs to, and the last org it reached. */
export interface GapRankCursor {
  pass: string;
  after: string;
}

/** Parse a stored cursor; anything unreadable (including the pre-#256 bare org id) reads as none. */
export function parseGapRankCursor(raw: string | null): GapRankCursor | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<GapRankCursor>;
    return typeof v.pass === 'string' && typeof v.after === 'string' ? { pass: v.pass, after: v.after } : null;
  } catch {
    return null;
  }
}

export async function gapRank(deps: EngineDeps, opts: { organization_id?: string; budgetMs?: number; pass_id?: string } = {}) {
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? GAP_RANK_BUDGET_MS;
  const only = opts.organization_id;
  const single = !!only;
  // The cursor belongs to ONE pass (#256): the worker's job id (the same across that job's retries),
  // else the UTC day. A cursor left by another pass (yesterday's unfinished one, a stale call) is
  // ignored and this pass starts at the first org, so no org is skipped for the day.
  const pass = opts.pass_id ?? `day:${utcDate(deps.now())}`;
  const storedRaw = single ? null : await deps.cursors.get(GAP_RANK_CURSOR);
  const stored = parseGapRankCursor(storedRaw);
  let after = '';
  if (!single && stored && stored.pass === pass) after = stored.after;
  else if (!single && storedRaw && (!stored || stored.after !== '')) {
    deps.log.warn(
      { pass, leftover: storedRaw },
      'bastion-gap-rank: a cursor from another pass was left mid-list; this pass starts from the first org instead',
    );
  }
  // The value this call last wrote (or read): every move is a compare-and-set against it, so a
  // call that lost the cursor to another call of the same pass stops instead of moving it back.
  let mine: string | null = storedRaw;
  const orgs = (
    await deps.sql`SELECT organization_id FROM bastion_org_settings
                    ${only ? deps.sql`WHERE organization_id = ${only}` : after ? deps.sql`WHERE organization_id > ${after}::uuid` : deps.sql``}
                    ORDER BY organization_id`
  ).map((r) => String(r.organization_id));
  deps.log.info(
    { orgs: orgs.length, resumed_after: after || null },
    `bastion-gap-rank: ranking gaps for ${orgs.length} org(s)${after ? ` (resuming after ${after})` : ''}`,
  );
  const totals = {
    orgs: orgs.length,
    ranked: 0,
    skipped_busy: 0,
    open: 0,
    inserted: 0,
    reopened: 0,
    resolved: 0,
    failed: 0,
    complete: true,
    /** True when another call of this pass moved the cursor first; this call stopped (#256). */
    superseded: false,
    elapsed_ms: 0,
  };
  const moveCursor = async (nextAfter: string): Promise<boolean> => {
    const next = JSON.stringify({ pass, after: nextAfter } satisfies GapRankCursor);
    if (!(await deps.cursors.compareAndSet(GAP_RANK_CURSOR, mine, next))) return false;
    mine = next;
    return true;
  };
  for (const [i, orgId] of orgs.entries()) {
    // At least one org per call, so a pass always makes progress.
    if (!single && i > 0 && Date.now() - started >= budgetMs) {
      totals.complete = false;
      deps.log.info({ done: i, of: orgs.length, budget_ms: budgetMs }, `bastion-gap-rank: time budget used after ${i}/${orgs.length} org(s); the next call resumes`);
      break;
    }
    try {
      const r = await orgTx(deps.sql, orgId, async (tx) => {
        if (single) return rankOrgGaps(tx, orgId, deps.now());
        if (!(await tryLockOrgGapRank(tx, orgId))) return null;
        return rankOrgGapsLocked(tx, orgId, deps.now());
      });
      if (!r) {
        totals.skipped_busy += 1;
        deps.log.info({ organization_id: orgId }, `bastion-gap-rank: org ${i + 1}/${orgs.length} is being ranked by another pass; skipped`);
      } else {
        totals.ranked += 1;
        totals.open += r.open;
        totals.inserted += r.inserted;
        totals.reopened += r.reopened;
        totals.resolved += r.resolved;
        deps.log.info({ organization_id: orgId, ...r }, `bastion-gap-rank: org ${i + 1}/${orgs.length} open ${r.open} new ${r.inserted} resolved ${r.resolved}`);
      }
    } catch (err) {
      totals.failed += 1;
      deps.log.error({ organization_id: orgId, err: (err as Error).message }, 'bastion-gap-rank: ranking failed for this org; the next run retries');
    }
    if (!single && !(await moveCursor(orgId))) {
      // Another call of this pass (a worker retry while this one ran past its timeout) owns the
      // cursor now: stop here rather than overwrite it with an older position.
      totals.complete = false;
      totals.superseded = true;
      deps.log.warn({ organization_id: orgId, pass }, 'bastion-gap-rank: another call of this pass moved the cursor; this call stops');
      break;
    }
  }
  if (!single && totals.complete) {
    // The pass reached the end: an empty position for this pass (a later call of it starts over).
    if (!(await moveCursor(''))) {
      totals.complete = false;
      totals.superseded = true;
    }
  }
  totals.elapsed_ms = Date.now() - started;
  deps.log.info(totals, totals.complete ? 'bastion-gap-rank: complete' : 'bastion-gap-rank: paused (budget); call again to continue');
  return totals;
}
