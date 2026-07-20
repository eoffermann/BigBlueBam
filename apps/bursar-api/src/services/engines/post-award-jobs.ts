import { sql } from 'drizzle-orm';
import { publishBoltEvent } from '@bigbluebam/shared';
import { runInOrgScope } from '../../plugins/rls.js';
import { db } from '../../db/index.js';
import { loadSettings } from '../settings.service.js';
import { bursarSweepLockKey } from './drift.engine.js';

// The remaining scheduled bursar engines (spec 15, M8): mismatch-reconcile, retention, weekly-digest,
// draft-reconcile. Each is org-scoped and idempotent; reconcile shares the drift-sweep advisory lock
// class so the two never flap (reconcile is offset to :05/:35 to run after a sweep tick).

function pgRows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

interface Logger {
  info: (obj: unknown, msg?: string) => void;
}

/* ------------------------------------------------------------------ */
/*  mismatch-reconcile: close findings whose evidence no longer holds */
/* ------------------------------------------------------------------ */

async function allOrgsWithFindings(): Promise<string[]> {
  const raw = await db.execute(sql`SELECT DISTINCT organization_id FROM bursar_mismatches WHERE status = 'open'`);
  return pgRows<{ organization_id: string }>(raw).map((r) => r.organization_id);
}

export async function runMismatchReconcile(logger: Logger, orgId: string | undefined): Promise<{ orgs: number; closed: number }> {
  const orgs = orgId ? [orgId] : await allOrgsWithFindings();
  let closed = 0;
  for (const org of orgs) {
    closed += await reconcileOneOrg(logger, org);
  }
  logger.info({ orgs: orgs.length, closed }, 'bursar-mismatch-reconcile: complete');
  return { orgs: orgs.length, closed };
}

async function reconcileOneOrg(logger: Logger, orgId: string): Promise<number> {
  return runInOrgScope(orgId, async (tx) => {
    // Same per-org advisory lock class as the sweep. Non-blocking; skip if the sweep holds it.
    const got = pgRows<{ locked: boolean }>(
      await tx.execute(sql`SELECT pg_try_advisory_xact_lock(${bursarSweepLockKey(orgId)}) AS locked`),
    )[0]?.locked;
    if (!got) return 0;

    // 1. unbaselined_vendor findings whose payee now HAS an active award -> evidence gone -> resolve.
    const closedUnbaselined = pgRows<{ id: string; detector: string }>(
      await tx.execute(sql`
        UPDATE bursar_mismatches m
           SET status = 'resolved', resolved_at = now(), updated_at = now()
         WHERE m.organization_id = ${orgId} AND m.status = 'open' AND m.detector = 'unbaselined_vendor'
           AND EXISTS (
             SELECT 1 FROM bursar_spend_events se
              JOIN bursar_awards a ON a.organization_id = se.organization_id AND a.vendor_id = se.vendor_id AND a.status = 'active'
             WHERE se.organization_id = m.organization_id AND se.normalized_payee = m.normalized_payee
           )
        RETURNING id, detector
      `),
    );

    // 2. findings tied to a spend event or baseline item that no longer exists -> resolve.
    const closedOrphans = pgRows<{ id: string; detector: string }>(
      await tx.execute(sql`
        UPDATE bursar_mismatches m
           SET status = 'resolved', resolved_at = now(), updated_at = now()
         WHERE m.organization_id = ${orgId} AND m.status = 'open'
           AND (
             (m.spend_event_id IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM bursar_spend_events se WHERE se.id = m.spend_event_id AND se.organization_id = m.organization_id))
             OR (m.baseline_item_id IS NOT NULL AND NOT EXISTS (
               SELECT 1 FROM bursar_baseline_items bi WHERE bi.id = m.baseline_item_id AND bi.organization_id = m.organization_id))
           )
        RETURNING id, detector
      `),
    );

    // 3. renewal_cliff findings whose award is no longer active -> resolve.
    const closedRenewals = pgRows<{ id: string; detector: string }>(
      await tx.execute(sql`
        UPDATE bursar_mismatches m
           SET status = 'resolved', resolved_at = now(), updated_at = now()
         WHERE m.organization_id = ${orgId} AND m.status = 'open' AND m.detector = 'renewal_cliff'
           AND m.award_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM bursar_awards a WHERE a.id = m.award_id AND a.status = 'active')
        RETURNING id, detector
      `),
    );

    const all = [...closedUnbaselined, ...closedOrphans, ...closedRenewals];
    for (const c of all) {
      void publishBoltEvent(
        'mismatch.resolved',
        'bursar',
        { 'mismatch.id': c.id, detector: c.detector, status: 'resolved', 'org.id': orgId },
        orgId,
      ).catch(() => {});
    }
    logger.info({ orgId, closed: all.length }, 'bursar-mismatch-reconcile: org done');
    return all.length;
  });
}

/* ------------------------------------------------------------------ */
/*  retention: prune, baseline items EXCLUDED                         */
/* ------------------------------------------------------------------ */

export async function runRetention(logger: Logger, orgId: string | undefined): Promise<{ orgs: number; pruned: number }> {
  const orgs = orgId ? [orgId] : pgRows<{ organization_id: string }>(
    await db.execute(sql`SELECT organization_id FROM bursar_org_settings`),
  ).map((r) => r.organization_id);
  let pruned = 0;
  for (const org of orgs) {
    pruned += await retentionOneOrg(logger, org);
  }
  logger.info({ orgs: orgs.length, pruned }, 'bursar-retention: complete');
  return { orgs: orgs.length, pruned };
}

// The tables retention prunes. bursar_baseline_items is DELIBERATELY ABSENT: the frozen baseline is
// the immutable record the detectors measure against and is protected by four-path triggers (0249).
const RETENTION_TABLES_EXCLUDING_BASELINE = ['bursar_gate_checks', 'bursar_ingest_events'] as const;

async function retentionOneOrg(logger: Logger, orgId: string): Promise<number> {
  return runInOrgScope(orgId, async (tx) => {
    const settings = await loadSettings(tx, orgId);
    const days = Number(settings.retention_days ?? 730);
    const cutoff = `${days} days`;
    let pruned = 0;

    // Resolved/dismissed findings past retention.
    const m = pgRows<{ id: string }>(
      await tx.execute(sql`
        DELETE FROM bursar_mismatches
         WHERE organization_id = ${orgId} AND status IN ('resolved', 'dismissed')
           AND updated_at < now() - ${cutoff}::interval
        RETURNING id
      `),
    );
    pruned += m.length;

    // Gate checks + processed ingest events past retention. (bursar_baseline_items is never pruned.)
    for (const table of RETENTION_TABLES_EXCLUDING_BASELINE) {
      const col = table === 'bursar_ingest_events' ? 'received_at' : 'created_at';
      const r = pgRows<{ id: string }>(
        await tx.execute(sql`
          DELETE FROM ${sql.identifier(table)}
           WHERE organization_id = ${orgId} AND ${sql.identifier(col)} < now() - ${cutoff}::interval
          RETURNING id
        `),
      );
      pruned += r.length;
    }
    logger.info({ orgId, pruned, retention_days: days }, 'bursar-retention: org done');
    return pruned;
  });
}

/* ------------------------------------------------------------------ */
/*  weekly-digest: IN-APP notifications (resolved channel decision)   */
/* ------------------------------------------------------------------ */

export async function runWeeklyDigest(logger: Logger, orgId: string | undefined): Promise<{ orgs: number; notified: number }> {
  const orgs = orgId ? [orgId] : pgRows<{ organization_id: string }>(
    await db.execute(sql`SELECT organization_id FROM bursar_org_settings`),
  ).map((r) => r.organization_id);
  let notified = 0;
  for (const org of orgs) {
    notified += await digestOneOrg(logger, org);
  }
  logger.info({ orgs: orgs.length, notified }, 'bursar-weekly-digest: complete');
  return { orgs: orgs.length, notified };
}

async function digestOneOrg(logger: Logger, orgId: string): Promise<number> {
  return runInOrgScope(orgId, async (tx) => {
    const counts = pgRows<{ open_findings: number; at_stake: number }>(
      await tx.execute(sql`
        SELECT count(*) FILTER (WHERE status = 'open')::int AS open_findings,
               COALESCE(sum(dollars_at_stake_minor) FILTER (WHERE status = 'open'), 0)::bigint AS at_stake
          FROM bursar_mismatches WHERE organization_id = ${orgId}
      `),
    )[0] ?? { open_findings: 0, at_stake: 0 };
    const renewals = pgRows<{ n: number }>(
      await tx.execute(sql`
        SELECT count(*)::int AS n FROM bursar_renewals
         WHERE organization_id = ${orgId} AND status = 'pending' AND current_band IS NOT NULL
      `),
    )[0]?.n ?? 0;

    if (counts.open_findings === 0 && renewals === 0) return 0;

    // Deliver as IN-APP notifications to org owners/admins (channel decision: in-app; see WIP doc).
    const admins = pgRows<{ user_id: string }>(
      await tx.execute(sql`
        SELECT user_id FROM organization_memberships
         WHERE org_id = ${orgId} AND role IN ('owner', 'admin')
      `),
    );
    const title = `Bursar weekly digest: ${counts.open_findings} open finding(s), ${renewals} renewal(s) approaching`;
    const body = `You have ${counts.open_findings} open spend/scope findings and ${renewals} contract renewals inside a notice window. Open Bursar to review.`;
    let n = 0;
    for (const a of admins) {
      await tx.execute(sql`
        INSERT INTO notifications (user_id, type, title, body)
        VALUES (${a.user_id}, 'bursar_digest', ${title}, ${body})
      `);
      n += 1;
    }
    logger.info({ orgId, notified: n, open_findings: counts.open_findings, renewals }, 'bursar-weekly-digest: org done');
    return n;
  });
}

/* ------------------------------------------------------------------ */
/*  draft-reconcile: reflect proposal.decided onto bursar_drafts      */
/* ------------------------------------------------------------------ */

export async function runDraftReconcile(logger: Logger, orgId: string | undefined): Promise<{ orgs: number; reflected: number }> {
  const orgs = orgId ? [orgId] : pgRows<{ organization_id: string }>(
    await db.execute(sql`SELECT DISTINCT organization_id FROM bursar_drafts WHERE status = 'pending'`),
  ).map((r) => r.organization_id);
  let reflected = 0;
  for (const org of orgs) {
    reflected += await draftReconcileOneOrg(logger, org);
  }
  logger.info({ orgs: orgs.length, reflected }, 'bursar-draft-reconcile: complete');
  return { orgs: orgs.length, reflected };
}

async function draftReconcileOneOrg(logger: Logger, orgId: string): Promise<number> {
  return runInOrgScope(orgId, async (tx) => {
    // A pending draft whose linked agent_proposals row was decided -> reflect the decision. This is
    // the pull-based consumer of proposal.decided (spec 16.2): robust to a dropped push, idempotent.
    const rows = pgRows<{ id: string; proposal_status: string }>(
      await tx.execute(sql`
        SELECT d.id, p.status AS proposal_status
          FROM bursar_drafts d
          JOIN agent_proposals p ON p.id = d.proposal_id
         WHERE d.organization_id = ${orgId} AND d.status = 'pending'
           AND p.status IN ('approved', 'rejected')
      `),
    );
    let reflected = 0;
    for (const r of rows) {
      const newStatus = r.proposal_status === 'approved' ? 'approved' : 'rejected';
      await tx.execute(sql`
        UPDATE bursar_drafts
           SET status = ${newStatus},
               ${newStatus === 'approved' ? sql`approved_at = now()` : sql`rejected_at = now()`},
               updated_at = now()
         WHERE organization_id = ${orgId} AND id = ${r.id}
      `);
      void publishBoltEvent(
        'draft.decided',
        'bursar',
        { 'draft.id': r.id, decision: newStatus, 'org.id': orgId },
        orgId,
      ).catch(() => {});
      reflected += 1;
    }
    logger.info({ orgId, reflected }, 'bursar-draft-reconcile: org done');
    return reflected;
  });
}
