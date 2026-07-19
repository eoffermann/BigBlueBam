import { and, eq, lte, sql, inArray } from 'drizzle-orm';
import {
  publishBoltEvent,
  bulwarkDeadlineRuleSchema,
  bulwarkEventBindingSchema,
  type BulwarkDeadlineRule,
} from '@bigbluebam/shared';
import { calendarArmKey, eventArmKeyForBinding } from '@bigbluebam/shared/bulwark-arm-key';
import { db } from '../db/index.js';
import {
  bulwarkContracts,
  bulwarkIngestEvents,
  bulwarkNoticeDeadlines,
  bulwarkObligations,
  bulwarkWaiverRisks,
  bulwarkComplianceDocs,
  bulwarkVendorTiers,
} from '../db/schema/index.js';
import { armDeadline } from './arming.service.js';
import { draftNotice } from './send.service.js';
import { drainIngestEvent } from './firing.service.js';
import { getSettings } from './settings.service.js';
import { rebuildGate } from './gate.service.js';
import { computeDueAt, zonedWallClockToUtc } from './deadline-math.service.js';
import { publishBulwarkFrame } from '../lib/realtime.js';
import { createLogger } from '@bigbluebam/logging';

const log = createLogger({ service: 'bulwark-sweeps' });

// The scheduled Bulwark engines (spec §4.3 radar sweep, §4.5 state-reconcile + gate + retention).
// Every entry point is per-org and wrapped by the callers in try/catch log-and-continue; the
// worker jobs are thin HTTP callers that invoke the *All variants over every org (spec §9.2 /
// the brief: worker jobs CALL these via bulwark-api's internal surface).

function rows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

// A stable 63-bit-ish advisory-lock key for a (kind, org) pair. hashtext returns int4; we pass
// two int4s to pg_try_advisory_lock(int4,int4) so distinct sweep kinds never collide.
async function tryAdvisoryLock(kind: string, orgId: string): Promise<boolean> {
  const res = await db.execute(sql`
    SELECT pg_try_advisory_lock(hashtext(${kind}), hashtext(${orgId})) AS locked
  `);
  const r = rows<{ locked: boolean }>(res)[0];
  return r?.locked === true;
}
async function releaseAdvisoryLock(kind: string, orgId: string): Promise<void> {
  await db
    .execute(sql`SELECT pg_advisory_unlock(hashtext(${kind}), hashtext(${orgId}))`)
    .catch(() => {});
}

// ─── Org enumeration (shared) ───────────────────────────────────────────────
export async function orgsWithBulwarkData(): Promise<string[]> {
  const res = await db.execute(sql`
    SELECT DISTINCT organization_id FROM bulwark_contracts
    UNION
    SELECT DISTINCT organization_id FROM bulwark_ingest_events
  `);
  return rows<{ organization_id: string }>(res).map((r) => r.organization_id);
}

// ─── Radar sweep (spec §4.3) ────────────────────────────────────────────────

interface RadarLeadTimes {
  critical_hours: number;
  high_hours: number;
  medium_hours: number;
}

function severityForHours(hours: number, lead: RadarLeadTimes): 'low' | 'medium' | 'high' | 'critical' {
  if (hours <= lead.critical_hours) return 'critical';
  if (hours <= lead.high_hours) return 'high';
  if (hours <= lead.medium_hours) return 'medium';
  return 'low';
}

export interface RadarSweepResult {
  drained: number;
  risks: number;
  drafted: number;
  missed: number;
  calendar_armed: number;
  compliance_expiring: number;
}

const PENDING_DRAIN_AGE_MS = 2 * 60 * 1000;

export async function radarSweep(orgId: string): Promise<RadarSweepResult> {
  const result: RadarSweepResult = {
    drained: 0,
    risks: 0,
    drafted: 0,
    missed: 0,
    calendar_armed: 0,
    compliance_expiring: 0,
  };
  const locked = await tryAdvisoryLock('bulwark:radar', orgId);
  if (!locked) return result; // another instance holds the sweep for this org

  try {
    const settings = await getSettings(orgId);
    const lead = settings.radar_lead_times as RadarLeadTimes;

    // 0. Pending-inbox drain (STJ2): process inbox rows whose enqueue was lost.
    const pending = await db
      .select({ id: bulwarkIngestEvents.id })
      .from(bulwarkIngestEvents)
      .where(
        and(
          eq(bulwarkIngestEvents.organization_id, orgId),
          eq(bulwarkIngestEvents.status, 'pending'),
          lte(bulwarkIngestEvents.received_at, new Date(Date.now() - PENDING_DRAIN_AGE_MS)),
        ),
      )
      .limit(500);
    for (const p of pending) {
      const r = await drainIngestEvent(orgId, p.id).catch(() => null);
      if (r?.processed) result.drained++;
    }

    // 4. Calendar obligations (before risk so freshly-armed clocks are scanned this tick).
    result.calendar_armed = await armCalendarObligations(orgId);

    // 1 + 3. Approaching-risk + missed. Scan open deadlines.
    const openDeadlines = await db
      .select({ d: bulwarkNoticeDeadlines, c: bulwarkContracts, o: bulwarkObligations })
      .from(bulwarkNoticeDeadlines)
      .innerJoin(bulwarkContracts, eq(bulwarkContracts.id, bulwarkNoticeDeadlines.contract_id))
      .innerJoin(bulwarkObligations, eq(bulwarkObligations.id, bulwarkNoticeDeadlines.obligation_id))
      .where(
        and(
          eq(bulwarkNoticeDeadlines.organization_id, orgId),
          eq(bulwarkNoticeDeadlines.status, 'open'),
        ),
      )
      .limit(2000);

    const now = Date.now();
    let draftBudget = settings.auto_draft_notices ? settings.auto_draft_max_per_sweep : 0;
    if (draftBudget > 0) {
      // Respect the per-org daily LLM ceiling (S6): count today's drafted notices.
      const draftedToday = rows<{ n: number }>(
        await db.execute(sql`
          SELECT count(*)::int AS n FROM bulwark_notice_deadlines
           WHERE organization_id = ${orgId}
             AND notice_status <> 'none'
             AND updated_at >= date_trunc('day', now())
        `),
      )[0]?.n ?? 0;
      draftBudget = Math.max(0, Math.min(draftBudget, settings.notice_llm_daily_cap - draftedToday));
    }

    for (const { d, c, o } of openDeadlines) {
      const dueMs = new Date(d.due_at).getTime();
      const hoursRemaining = (dueMs - now) / 3_600_000;

      if (dueMs < now) {
        // 3. Missed: flip to missed and raise a critical/overdue risk (retained indefinitely, D3).
        const [won] = await db
          .update(bulwarkNoticeDeadlines)
          .set({ status: 'missed', radar_marker: new Date(now), updated_at: new Date() })
          .where(
            and(
              eq(bulwarkNoticeDeadlines.id, d.id),
              eq(bulwarkNoticeDeadlines.status, 'open'),
            ),
          )
          .returning({ id: bulwarkNoticeDeadlines.id });
        if (won) {
          result.missed++;
          await upsertRisk(orgId, {
            obligation_id: o.id,
            deadline_id: d.id,
            contract_id: c.id,
            severity: 'critical',
            reason: 'overdue',
            detail: { hours_overdue: Math.round(-hoursRemaining) },
            projectId: c.project_id,
          });
          result.risks++;
        }
        continue;
      }

      // 1. Approaching: map hours-remaining to severity and upsert a risk.
      const severity = severityForHours(hoursRemaining, lead);
      if (severity !== 'low') {
        const inserted = await upsertRisk(orgId, {
          obligation_id: o.id,
          deadline_id: d.id,
          contract_id: c.id,
          severity,
          reason: 'clock_running_out',
          detail: { hours_remaining: Math.round(hoursRemaining) },
          projectId: c.project_id,
        });
        if (inserted) result.risks++;
        await publishBoltEvent(
          'deadline.approaching',
          'bulwark',
          {
            deadline: { id: d.id },
            obligation: { id: o.id },
            contract: { id: c.id },
            due_at: new Date(d.due_at).toISOString(),
            hours_remaining: Math.round(hoursRemaining),
            org: { id: orgId },
          },
          orgId,
          undefined,
          'system',
        ).catch(() => {});

        // 2. Auto-draft (CAS-guarded, capped, D5): only notice type at >= high risk.
        if (
          draftBudget > 0 &&
          o.obligation_type === 'notice' &&
          (severity === 'high' || severity === 'critical') &&
          d.notice_status === 'none'
        ) {
          const drafted = await draftNotice(orgId, d.id).catch(() => ({ drafted: false }));
          if (drafted.drafted) {
            result.drafted++;
            draftBudget--;
          }
        }
      }
    }

    // Compliance validity sweep (folded here; emits compliance.expiring, spec §7).
    result.compliance_expiring = await sweepComplianceValidity(orgId, settings.coi_expiry_lead_days);

    // last_radar_sweep_at advances only after a fully-successful tick (Braid ST-r2-7).
    await db.execute(sql`
      INSERT INTO bulwark_org_settings (organization_id, last_radar_sweep_at)
      VALUES (${orgId}, now())
      ON CONFLICT (organization_id) DO UPDATE SET last_radar_sweep_at = now()
    `);
  } finally {
    await releaseAdvisoryLock('bulwark:radar', orgId);
  }
  return result;
}

interface RiskArgs {
  obligation_id: string;
  deadline_id: string | null;
  contract_id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  reason: 'clock_running_out' | 'overdue' | 'unbound_obligation' | 'missing_compliance_doc';
  detail: Record<string, unknown>;
  projectId: string | null;
}

// Idempotent risk upsert on (org, obligation, deadline, reason). Returns true when a NEW row
// was inserted (so the caller emits waiver.risk_detected exactly once per detection).
async function upsertRisk(orgId: string, args: RiskArgs): Promise<boolean> {
  const [row] = await db
    .insert(bulwarkWaiverRisks)
    .values({
      organization_id: orgId,
      obligation_id: args.obligation_id,
      deadline_id: args.deadline_id,
      contract_id: args.contract_id,
      severity: args.severity,
      reason: args.reason,
      detail: args.detail,
      status: 'open',
      detected_at: new Date(),
    })
    .onConflictDoNothing({
      target: [
        bulwarkWaiverRisks.organization_id,
        bulwarkWaiverRisks.obligation_id,
        bulwarkWaiverRisks.deadline_id,
        bulwarkWaiverRisks.reason,
      ],
    })
    .returning({ id: bulwarkWaiverRisks.id });
  if (!row) return false;
  await publishBoltEvent(
    'waiver.risk_detected',
    'bulwark',
    {
      risk: { id: row.id },
      obligation: { id: args.obligation_id },
      contract: { id: args.contract_id },
      severity: args.severity,
      reason: args.reason,
      org: { id: orgId },
    },
    orgId,
    undefined,
    'system',
  ).catch(() => {});
  await publishBulwarkFrame(orgId, args.projectId, {
    type: 'waiver.risk_detected',
    data: { risk_id: row.id, severity: args.severity, contract_id: args.contract_id },
  });
  return true;
}

// Arm calendar-derived obligations (renewal/termination) from the contract dates (spec §4.3
// step 4 + DI6 recurrence). Each arm dedups on the single unique arm index.
async function armCalendarObligations(orgId: string): Promise<number> {
  const obligations = await db
    .select({ o: bulwarkObligations, c: bulwarkContracts })
    .from(bulwarkObligations)
    .innerJoin(bulwarkContracts, eq(bulwarkContracts.id, bulwarkObligations.contract_id))
    .where(
      and(
        eq(bulwarkObligations.organization_id, orgId),
        eq(bulwarkObligations.is_armed, true),
        inArray(bulwarkObligations.obligation_type, ['renewal', 'termination']),
      ),
    )
    .limit(1000);

  let armed = 0;
  for (const { o, c } of obligations) {
    const parsed = bulwarkDeadlineRuleSchema.safeParse(o.deadline_rule);
    if (!parsed.success) continue;
    const rule: BulwarkDeadlineRule = parsed.data;
    if (rule.from === 'trigger_event') continue; // not calendar-derived
    const tz = rule.timezone || c.timezone;
    const baseDate = rule.from === 'contract_expiry_date' ? c.expiry_date : c.effective_date;
    if (!baseDate) continue;

    // Enumerate occurrence anchor dates: the base date, then roll forward by recurrence bounded
    // by until / contract.expiry_date. Capped so a misconfigured rule cannot arm unbounded.
    const anchors = enumerateAnchors(baseDate as unknown as string, rule, c.expiry_date as unknown as string | null);
    for (const anchorYmd of anchors) {
      const parts = anchorYmd.split('-').map(Number);
      const anchorInstant = zonedWallClockToUtc(parts[0]!, parts[1]!, parts[2]!, 0, 0, 0, tz);
      const { due_at, resolved_timezone } = computeDueAt({ anchor: anchorInstant, rule });
      const res = await armDeadline({
        orgId,
        obligationId: o.id,
        contractId: c.id,
        projectId: c.project_id,
        triggeringEventId: calendarArmKey(o.id, anchorYmd),
        anchorSource: 'calendar',
        triggeredAt: anchorInstant,
        resolvedTimezone: resolved_timezone,
        dueAt: due_at,
      });
      if (res.armed) armed++;
    }
  }
  return armed;
}

function enumerateAnchors(
  baseYmd: string,
  rule: BulwarkDeadlineRule,
  contractExpiry: string | null,
): string[] {
  const base = baseYmd.slice(0, 10);
  const out = [base];
  const rec = rule.recurrence;
  if (!rec) return out;
  // both null is rejected at confirm (DK4); here treat as one-shot defensively.
  const bound = rec.until ?? contractExpiry;
  if (!bound) return out;
  const boundMs = new Date(bound.slice(0, 10)).getTime();
  let cur = base;
  for (let i = 0; i < 200; i++) {
    const parts = cur.split('-').map(Number);
    const d = new Date(Date.UTC(parts[0]!, parts[1]! - 1, parts[2]!));
    if (rec.interval === 'annual') d.setUTCFullYear(d.getUTCFullYear() + 1);
    else if (rec.interval === 'quarterly') d.setUTCMonth(d.getUTCMonth() + 3);
    else d.setUTCMonth(d.getUTCMonth() + 1);
    const next = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    if (new Date(next).getTime() > boundMs) break;
    out.push(next);
    cur = next;
  }
  return out;
}

// Compliance validity sweep (spec §4.4 step 2 / §7). Transition docs to expiring/expired and
// emit compliance.expiring on the crossing. Recompute is left to the compliance sweep; here we
// only touch validity so `compliance.expiring` has a live emit site.
async function sweepComplianceValidity(orgId: string, leadDays: number): Promise<number> {
  const docs = await db
    .select({ doc: bulwarkComplianceDocs, tier: bulwarkVendorTiers })
    .from(bulwarkComplianceDocs)
    .innerJoin(bulwarkVendorTiers, eq(bulwarkVendorTiers.id, bulwarkComplianceDocs.vendor_tier_id))
    .where(eq(bulwarkComplianceDocs.organization_id, orgId))
    .limit(2000);

  let transitioned = 0;
  const now = Date.now();
  const leadMs = leadDays * 86_400_000;
  for (const { doc, tier } of docs) {
    if (!doc.expires_at) continue;
    const expMs = new Date(doc.expires_at as unknown as string).getTime();
    let next: 'valid' | 'expiring' | 'expired' = 'valid';
    if (expMs < now) next = 'expired';
    else if (expMs <= now + leadMs) next = 'expiring';
    if (next === 'valid' || doc.validity_status === next) continue;
    await db
      .update(bulwarkComplianceDocs)
      .set({ validity_status: next, updated_at: new Date() })
      .where(eq(bulwarkComplianceDocs.id, doc.id));
    transitioned++;
    await publishBoltEvent(
      'compliance.expiring',
      'bulwark',
      {
        compliance_doc: { id: doc.id },
        vendor_tier: { id: doc.vendor_tier_id },
        doc_type: doc.doc_type,
        expires_at: new Date(doc.expires_at as unknown as string).toISOString(),
        org: { id: orgId },
      },
      orgId,
      undefined,
      'system',
    ).catch(() => {});
    // Find the tier's contract project for scoped fan-out.
    const [ctr] = tier.contract_id
      ? await db
          .select({ project_id: bulwarkContracts.project_id })
          .from(bulwarkContracts)
          .where(eq(bulwarkContracts.id, tier.contract_id))
          .limit(1)
      : [{ project_id: null as string | null }];
    await publishBulwarkFrame(orgId, ctr?.project_id ?? null, {
      type: 'compliance.expiring',
      data: { compliance_doc_id: doc.id, vendor_tier_id: doc.vendor_tier_id },
    });
  }
  return transitioned;
}

// ─── State-reconcile (spec §4.5 / STJ1, the braid-rescan analog) ─────────────

// State-reflecting bindings: (source, event_type) whose trigger corresponds to a queryable
// persistent condition. For each, the SQL re-derives the currently-satisfying rows scoped by
// the obligation's entity_filter and yields { entityId, stateEpoch } so the SAME eventArmKey is
// recomputed (converging with the live drain). The beachhead is bam:task.overdue.
interface StateBinding {
  source: string;
  event_type: string;
  // Given (contract scope value, contract), returns matching source rows.
  query: (orgId: string, scopeValue: string | null) => Promise<Array<{ entityId: string; stateEpoch: string }>>;
}

const STATE_BINDINGS: StateBinding[] = [
  {
    source: 'bam',
    event_type: 'task.overdue',
    // A task past its due_date and not yet completed, scoped to the contract's project. The
    // state epoch is the task due_date. Convergence with the live drain (#67) is now ENFORCED,
    // not assumed: eventArmKeyForBinding normalizes this binding's epoch to a UTC day, so a live
    // task.overdue event whose trigger_at falls on the same day arms the SAME key regardless of
    // its time-of-day component.
    query: async (orgId, projectId) => {
      if (!projectId) return [];
      const res = await db.execute(sql`
        SELECT t.id AS entity_id, t.due_date AS state_epoch
          FROM tasks t
         WHERE t.org_id = ${orgId}
           AND t.project_id = ${projectId}
           AND t.due_date IS NOT NULL
           AND t.due_date < current_date
           AND t.completed_at IS NULL
         LIMIT 1000
      `);
      return rows<{ entity_id: string; state_epoch: string | Date }>(res).map((r) => ({
        entityId: r.entity_id,
        stateEpoch: new Date(r.state_epoch).toISOString(),
      }));
    },
  },
];

export interface StateReconcileResult {
  armed: number;
  obligations_scanned: number;
}

export async function stateReconcile(orgId: string): Promise<StateReconcileResult> {
  const result: StateReconcileResult = { armed: 0, obligations_scanned: 0 };

  // Armed, event-bound obligations whose binding is a state-reflecting type.
  const stateKeys = new Set(STATE_BINDINGS.map((b) => `${b.source}:${b.event_type}`));
  const obligations = await db
    .select({ o: bulwarkObligations, c: bulwarkContracts })
    .from(bulwarkObligations)
    .innerJoin(bulwarkContracts, eq(bulwarkContracts.id, bulwarkObligations.contract_id))
    .where(
      and(
        eq(bulwarkObligations.organization_id, orgId),
        eq(bulwarkObligations.is_armed, true),
      ),
    )
    .limit(2000);

  for (const { o, c } of obligations) {
    const binding = bulwarkEventBindingSchema.safeParse(o.event_binding);
    if (!binding.success) continue;
    const b = binding.data;
    if (!b.source || !b.event_type) continue;
    if (!stateKeys.has(`${b.source}:${b.event_type}`)) continue;
    const def = STATE_BINDINGS.find((sb) => sb.source === b.source && sb.event_type === b.event_type);
    if (!def) continue;
    const filter = b.entity_filter;
    if (!filter?.equals_contract_field) continue;
    result.obligations_scanned++;

    // The scope value the source rows must match (the contract field the filter compares to).
    const scopeValue =
      filter.equals_contract_field === 'project_id'
        ? c.project_id
        : filter.equals_contract_field === 'counterparty_id'
          ? c.counterparty_id
          : filter.equals_contract_field === 'id'
            ? c.id
            : null;

    const matches = await def.query(orgId, scopeValue).catch(() => []);
    const rule = bulwarkDeadlineRuleSchema.safeParse(o.deadline_rule);
    const effectiveRule: BulwarkDeadlineRule = rule.success
      ? rule.data
      : { offset_days: 0, unit: 'calendar_days', from: 'trigger_event', timezone: c.timezone, roll_forward: true, grace_hours: 0 };

    for (const m of matches) {
      const anchor = new Date(m.stateEpoch);
      const { due_at, resolved_timezone } = computeDueAt({ anchor, rule: effectiveRule });
      // The SAME deterministic key the live drain computes (#67): both callers go through
      // eventArmKeyForBinding, which normalizes a state-reflecting binding's epoch to a UTC day
      // so the live drain's full-timestamp trigger_at and this due_date-derived epoch converge
      // BYTE-FOR-BYTE. Persist the normalized epoch so a supersession re-point stays consistent.
      const { key: triggeringEventId, epoch: armEpoch } = eventArmKeyForBinding(
        o.id,
        m.entityId,
        m.stateEpoch,
        b.source,
        b.event_type,
      );
      const res = await armDeadline({
        orgId,
        obligationId: o.id,
        contractId: c.id,
        projectId: c.project_id,
        triggeringEventId,
        armScopeEntityId: m.entityId,
        armStateEpoch: armEpoch,
        anchorSource: 'trigger_at',
        triggeredAt: anchor,
        resolvedTimezone: resolved_timezone,
        dueAt: due_at,
      });
      if (res.armed) result.armed++;
    }
  }

  // Rebuild the Redis gate from the authoritative table on the same cadence (STJ3).
  await rebuildGate(orgId).catch(() => {});
  return result;
}

// ─── Retention (spec §4.5 / D3 / STJ7) ──────────────────────────────────────

export interface RetentionResult {
  discharged_purged: number;
  inbox_purged: number;
}

export async function retentionSweep(orgId: string): Promise<RetentionResult> {
  const settings = await getSettings(orgId);
  // Couple the floors so a late redelivery can never re-arm a purged clock: the discharged
  // purge cutoff is computed from the (larger) inbox floor in the SAME run (STJ7).
  const inboxDays = Math.max(settings.inbox_retention_days, settings.discharged_deadline_retention_days);
  const dischargedDays = Math.min(settings.discharged_deadline_retention_days, inboxDays);

  // Only discharged deadlines are purged; missed/waived/voided + ALL waiver_risks kept forever.
  // Low-volume (discharged deadlines only), so a single ranged DELETE is fine here.
  const dischargedRes = await db.execute(sql`
    DELETE FROM bulwark_notice_deadlines
     WHERE organization_id = ${orgId}
       AND status = 'discharged'
       AND coalesce(discharged_at, updated_at) < now() - (${dischargedDays} || ' days')::interval
  `);

  // bulwark_ingest_events is the self-flagged HIGHEST-CHURN table (migration 0234). At scale an
  // unbatched ~400-day ranged DELETE risks a long lock + autovacuum pressure, so purge it in
  // bounded chunks (ctid batches) until the window is drained, with flushed per-batch progress
  // logging (#69). Partitioning is the durable fix (spec Open Question 10 / ST9) and is a
  // documented fast-follow; this keeps the sweep safe until then.
  const inboxPurged = await batchedInboxPurge(orgId, inboxDays);

  return {
    discharged_purged: (dischargedRes as { count?: number }).count ?? 0,
    inbox_purged: inboxPurged,
  };
}

const INBOX_PURGE_BATCH = 5000;
const INBOX_PURGE_MAX_BATCHES = 10_000; // hard stop so a clock skew can never loop unbounded

// Delete aged inbox rows for one org in bounded ctid batches. Returns the total purged. Each
// batch is its own statement/transaction so locks are short and autovacuum can keep up; progress
// is logged flushed per batch (pino) so a large purge is never a silent stall (#69).
async function batchedInboxPurge(orgId: string, inboxDays: number): Promise<number> {
  const started = Date.now();
  let total = 0;
  let batch = 0;
  for (; batch < INBOX_PURGE_MAX_BATCHES; batch++) {
    const res = await db.execute(sql`
      DELETE FROM bulwark_ingest_events
       WHERE ctid IN (
         SELECT ctid FROM bulwark_ingest_events
          WHERE organization_id = ${orgId}
            AND received_at < now() - (${inboxDays} || ' days')::interval
          LIMIT ${INBOX_PURGE_BATCH}
       )
    `);
    const n = (res as { count?: number }).count ?? 0;
    total += n;
    if (n > 0) {
      log.info(
        { orgId, batch: batch + 1, purgedThisBatch: n, purgedTotal: total, elapsedMs: Date.now() - started },
        'bulwark-retention: inbox purge batch',
      );
    }
    if (n < INBOX_PURGE_BATCH) break; // final (short) batch drained the window
  }
  if (total > 0) {
    log.info(
      { orgId, batches: batch + 1, purgedTotal: total, elapsedMs: Date.now() - started },
      'bulwark-retention: inbox purge complete',
    );
  }
  return total;
}
