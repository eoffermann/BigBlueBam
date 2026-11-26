// The two M5 scheduled engines (spec 7), run by the worker's thin jobs through
// POST /v1/internal/engines/<name>. Org by org, each org in its own transactions, logging a start
// line and per-org progress (spec 7.1).
//
//   evidence-ingest  (event + */10)  retries `pending_scan` uploads whose next attempt is due (5 min
//                    doubling to 6 h, then once a day after 24 h), and turns pending Bolt-event inbox
//                    rows into feed records for Bolt-event feeds, and retries the bucket delete of
//                    redacted bytes whose delete failed at redaction time (#212).
//   evidence-expiry  (10 6 * * *)    evidence inside the warning window publishes evidence.expiring
//                    once per item; expired evidence publishes evidence.expired once per item and
//                    re-evaluates the controls it is linked to; accepted risks that ran out expire (M6).

import { BASTION_DAY_MS } from '@bigbluebam/shared';
import { EVIDENCE_INGEST_START_CUTOFF_MS, evidenceCopyBudgetMs } from '../engine/budgets.js';
import { type EngineDeps, orgTx } from '../engine/context.js';
import { type QueuedRun, queueControlRuns } from '../engine/evidence-store.js';
import { daysLeft } from '../engine/manual.js';
import { enqueueBastionEvent } from '../engine/outbox.js';
import type { EvidenceDeps } from './evidence-deps.js';
import { ingestBoltEventFeeds } from './feeds.service.js';
import { expireExceptions } from './exceptions.service.js';
import { retryPendingScan, retryRedactedDeletes, type ScanRetryOutcome } from './manual-evidence.service.js';

const DAY_MS = BASTION_DAY_MS;

async function orgsWith(engine: EngineDeps, sqlWhere: 'pending' | 'feeds' | 'evidence', only?: string): Promise<string[]> {
  const rows =
    sqlWhere === 'pending'
      ? await engine.sql`SELECT DISTINCT organization_id FROM bastion_manual_evidence
                          WHERE status = 'pending_scan' AND (next_attempt_at IS NULL OR next_attempt_at <= ${engine.now()})
                          ${only ? engine.sql`AND organization_id = ${only}` : engine.sql``}`
      : sqlWhere === 'feeds'
        ? await engine.sql`SELECT DISTINCT organization_id FROM bastion_evidence_feeds
                            WHERE source_kind = 'bolt_event' AND status = 'active'
                            ${only ? engine.sql`AND organization_id = ${only}` : engine.sql``}`
        : await engine.sql`SELECT DISTINCT organization_id FROM bastion_manual_evidence
                            WHERE status = 'active' AND valid_until IS NOT NULL AND expired_notified_at IS NULL
                            ${only ? engine.sql`AND organization_id = ${only}` : engine.sql``}`;
  return rows.map((r) => String(r.organization_id));
}

export async function evidenceIngest(d: EvidenceDeps, opts: { organization_id?: string; manual_evidence_id?: string } = {}) {
  const engine = d.engine;
  const started = Date.now();
  const outcomes: ScanRetryOutcome[] = [];
  const orgs = await orgsWith(engine, 'pending', opts.organization_id);
  engine.log.info({ orgs: orgs.length }, `bastion-evidence-ingest: ${orgs.length} org(s) with uploads waiting for a scan`);
  for (const [i, orgId] of orgs.entries()) {
    const due = await orgTx(engine.sql, orgId, (tx) => tx`
      SELECT id FROM bastion_manual_evidence
       WHERE organization_id = ${orgId} AND status = 'pending_scan' AND (next_attempt_at IS NULL OR next_attempt_at <= ${engine.now()})
         ${opts.manual_evidence_id ? tx`AND id = ${opts.manual_evidence_id}` : tx``}
       ORDER BY next_attempt_at NULLS FIRST, created_at LIMIT 100`);
    for (const r of due) {
      const elapsed = Date.now() - started;
      if (elapsed > EVIDENCE_INGEST_START_CUTOFF_MS) break;
      try {
        // Bound each copy by what is left of this call (#222): one that will not fit starts in the
        // background under its lease instead of running past the worker's engine timeout.
        outcomes.push(await retryPendingScan(d, orgId, String(r.id), { copyBudgetMs: evidenceCopyBudgetMs(elapsed) }));
      } catch (err) {
        engine.log.warn({ organization_id: orgId, manual_evidence_id: r.id, err: (err as Error).message }, 'bastion-evidence-ingest: retry failed; it stays pending');
      }
    }
    engine.log.info({ organization_id: orgId }, `bastion-evidence-ingest: scans checked for org ${i + 1}/${orgs.length}`);
  }
  let recorded = 0;
  let duplicates = 0;
  let quotaBlocked = 0;
  for (const orgId of await orgsWith(engine, 'feeds', opts.organization_id)) {
    try {
      const r = await ingestBoltEventFeeds(engine, orgId);
      recorded += r.recorded;
      duplicates += r.duplicates;
      quotaBlocked += r.quota_blocked;
    } catch (err) {
      engine.log.warn({ organization_id: orgId, err: (err as Error).message }, 'bastion-evidence-ingest: Bolt-event feed records not written; next run retries');
    }
  }
  // Redacted bytes whose bucket delete failed at redaction time (#212): retried until confirmed.
  let redacted = { deleted: 0, still_pending: 0 };
  try {
    redacted = await retryRedactedDeletes(engine, opts.organization_id);
    if (redacted.deleted + redacted.still_pending > 0) {
      engine.log.info(redacted, `bastion-evidence-ingest: redacted files deleted ${redacted.deleted}, still pending ${redacted.still_pending}`);
    }
  } catch (err) {
    engine.log.warn({ err: (err as Error).message }, 'bastion-evidence-ingest: redacted-file delete retry failed; next run retries');
  }
  const summary = {
    scans_checked: outcomes.filter((o) => o.result !== 'skipped').length,
    copied: outcomes.filter((o) => o.result === 'copied').length,
    copies_started: outcomes.filter((o) => o.result === 'copy_started').length,
    still_pending: outcomes.filter((o) => o.result === 'still_pending').length,
    blocked: outcomes.filter((o) => o.result === 'blocked').length,
    feed_records: recorded,
    feed_duplicates: duplicates,
    feed_quota_blocked: quotaBlocked,
    redacted_bytes_deleted: redacted.deleted,
    redacted_bytes_pending: redacted.still_pending,
    elapsed_ms: Date.now() - started,
  };
  engine.log.info(summary, `bastion-evidence-ingest: copied ${summary.copied}, still pending ${summary.still_pending}, blocked ${summary.blocked}, feed records ${recorded}`);
  return summary;
}

export async function evidenceExpiry(d: EvidenceDeps, opts: { organization_id?: string } = {}) {
  const engine = d.engine;
  const now = engine.now();
  const orgs = await orgsWith(engine, 'evidence', opts.organization_id);
  engine.log.info({ orgs: orgs.length }, `bastion-evidence-expiry: checking ${orgs.length} org(s)`);
  let expiring = 0;
  let expired = 0;
  const runs: QueuedRun[] = [];
  for (const [i, orgId] of orgs.entries()) {
    const r = await orgTx(engine.sql, orgId, async (tx) => {
      const settings = (await tx`SELECT manual_expiry_warn_days FROM bastion_org_settings WHERE organization_id = ${orgId}`)[0];
      const warn = Number(settings?.manual_expiry_warn_days ?? 30);
      // The once-per-item markers live on the row (#220): outbox rows are pruned after 30 days, so
      // they cannot be the "already sent" record. An item whose expired notice went out is never
      // selected again, which also keeps this scan bounded.
      const items = await tx`
        SELECT id, valid_until, owner_user_id, expiring_notified_at FROM bastion_manual_evidence
         WHERE organization_id = ${orgId} AND status = 'active' AND valid_until IS NOT NULL AND expired_notified_at IS NULL
           AND valid_until <= ${new Date(now.getTime() + warn * DAY_MS)}`;
      let soon = 0;
      let gone = 0;
      const controls = new Set<string>();
      for (const it of items) {
        const until = new Date(it.valid_until as string);
        const id = it.id as string;
        if (until.getTime() > now.getTime()) {
          if (it.expiring_notified_at) continue;
          const claimed = await tx`UPDATE bastion_manual_evidence SET expiring_notified_at = ${now}
                                    WHERE organization_id = ${orgId} AND id = ${id} AND expiring_notified_at IS NULL RETURNING id`;
          if (claimed.length === 0) continue;
          await enqueueBastionEvent(
            'evidence.expiring',
            { manual_evidence_id: id, valid_until: until.toISOString(), days_left: daysLeft(until, now), owner_user_id: it.owner_user_id },
            tx,
            { orgId, idempotencyKey: `evidence.expiring:${id}:${until.toISOString()}` },
          );
          soon += 1;
          continue;
        }
        const claimed = await tx`UPDATE bastion_manual_evidence SET expired_notified_at = ${now}
                                  WHERE organization_id = ${orgId} AND id = ${id} AND expired_notified_at IS NULL RETURNING id`;
        if (claimed.length === 0) continue;
        await enqueueBastionEvent(
          'evidence.expired',
          { manual_evidence_id: id, valid_until: until.toISOString(), owner_user_id: it.owner_user_id },
          tx,
          { orgId, idempotencyKey: `evidence.expired:${id}:${until.toISOString()}` },
        );
        gone += 1;
        const linked = await tx`
          SELECT DISTINCT a.control_id FROM bastion_manual_evidence_links l
            JOIN bastion_assertions a ON a.id = l.assertion_id AND a.organization_id = l.organization_id
           WHERE l.organization_id = ${orgId} AND l.manual_evidence_id = ${id} AND l.unlinked_at IS NULL`;
        for (const c of linked) controls.add(String(c.control_id));
      }
      const queued = await queueControlRuns(tx, orgId, controls, now, null, 'manual');
      return { soon, gone, queued };
    });
    expiring += r.soon;
    expired += r.gone;
    runs.push(...r.queued);
    engine.log.info({ organization_id: orgId }, `bastion-evidence-expiry: org ${i + 1}/${orgs.length} expiring ${r.soon} expired ${r.gone}`);
  }
  if (runs.length > 0) await d.enqueueRuns(runs).catch(() => undefined);

  // Exceptions whose time is up (spec 2.6, M6): one transaction per org, drift and its outbox
  // rows written with the expiry, idempotent on the exception id.
  let exceptionsExpired = 0;
  let exceptionDrift = 0;
  const exOrgs = (
    await engine.sql`SELECT DISTINCT organization_id FROM bastion_exceptions WHERE status = 'active' AND expires_at <= ${now}
                      ${opts.organization_id ? engine.sql`AND organization_id = ${opts.organization_id}` : engine.sql``}`
  ).map((r) => String(r.organization_id));
  engine.log.info({ orgs: exOrgs.length }, `bastion-evidence-expiry: ${exOrgs.length} org(s) with accepted risks that ran out`);
  for (const orgId of exOrgs) {
    try {
      const r = await orgTx(engine.sql, orgId, (tx) => expireExceptions(tx, orgId, now));
      exceptionsExpired += r.expired;
      exceptionDrift += r.drifted;
      engine.log.info({ organization_id: orgId, ...r }, `bastion-evidence-expiry: ${r.expired} exception(s) expired, ${r.drifted} control(s) drifted`);
    } catch (err) {
      engine.log.error({ organization_id: orgId, err: (err as Error).message }, 'bastion-evidence-expiry: exception expiry failed for this org; the next run retries');
    }
  }
  const summary = {
    expiring_notified: expiring,
    expired_notified: expired,
    controls_reevaluating: runs.length,
    exceptions_expired: exceptionsExpired,
    exception_drift: exceptionDrift,
  };
  engine.log.info(summary, 'bastion-evidence-expiry: complete');
  return summary;
}
