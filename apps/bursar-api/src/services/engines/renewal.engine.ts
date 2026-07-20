import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { publishBoltEvent } from '@bigbluebam/shared';
import { runInOrgScope } from '../../plugins/rls.js';
import { db } from '../../db/index.js';
import { currentRenewalBand, bandsToAlert, addDays } from './detectors-logic.js';

/**
 * The bursar-renewal-radar engine (spec 8 detector 4, 15, M8). For every active bounded award it
 * maintains one bursar_renewals row, computes the notice_deadline (term_end minus renewal_notice_days,
 * anchored in the award timezone), and fires renewal.approaching + a renewal_cliff finding each time
 * the deadline crosses into a tighter lead band. alerted_bands gives per-band idempotency; an
 * auto-renew award that has not been reviewed absorbs a severity bump.
 */

function pgRows<T>(raw: unknown): T[] {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] }).rows ?? [])) as T[];
}

interface Logger {
  info: (obj: unknown, msg?: string) => void;
}

export interface RenewalRadarSummary {
  orgs: number;
  awards_scanned: number;
  bands_fired: number;
}

async function orgsWithBoundedActiveAwards(): Promise<string[]> {
  const raw = await db.execute(sql`
    SELECT DISTINCT organization_id FROM bursar_awards
     WHERE status = 'active' AND term_end IS NOT NULL
  `);
  return pgRows<{ organization_id: string }>(raw).map((r) => r.organization_id);
}

export async function runRenewalRadar(logger: Logger, orgId: string | undefined): Promise<RenewalRadarSummary> {
  const started = Date.now();
  const orgs = orgId ? [orgId] : await orgsWithBoundedActiveAwards();
  const summary: RenewalRadarSummary = { orgs: orgs.length, awards_scanned: 0, bands_fired: 0 };
  for (const org of orgs) {
    const s = await radarOneOrg(logger, org);
    summary.awards_scanned += s.awards_scanned;
    summary.bands_fired += s.bands_fired;
  }
  logger.info({ ...summary, elapsedMs: Date.now() - started }, 'bursar-renewal-radar: complete');
  return summary;
}

async function radarOneOrg(logger: Logger, orgId: string): Promise<{ awards_scanned: number; bands_fired: number }> {
  return runInOrgScope(orgId, async (tx) => {
    const awards = pgRows<{
      id: string;
      chain_root_id: string | null;
      vendor_id: string | null;
      term_end: string;
      renewal_notice_days: number | null;
      auto_renew: boolean;
      timezone: string;
    }>(
      await tx.execute(sql`
        SELECT id, chain_root_id, vendor_id, term_end::text AS term_end, renewal_notice_days,
               auto_renew, timezone
          FROM bursar_awards
         WHERE organization_id = ${orgId} AND status = 'active' AND term_end IS NOT NULL
      `),
    );
    // "today" in the award timezone would need tz math; the sweep uses UTC date, which is within a
    // day of any business tz and is the conservative anchor for a >= band threshold (spec 8).
    const today = new Date().toISOString().slice(0, 10);
    let fired = 0;
    for (const a of awards) {
      const noticeDeadline = a.renewal_notice_days ? addDays(a.term_end, -a.renewal_notice_days) : a.term_end;
      const band = currentRenewalBand(noticeDeadline, today);

      // Upsert the radar row (one per award).
      const existing = pgRows<{ id: string; alerted_bands: string[]; status: string }>(
        await tx.execute(sql`
          SELECT id, alerted_bands, status FROM bursar_renewals
           WHERE organization_id = ${orgId} AND award_id = ${a.id} LIMIT 1
        `),
      )[0];
      const alerted = existing?.alerted_bands ?? [];
      const due = bandsToAlert(band, alerted);

      if (!existing) {
        await tx.execute(sql`
          INSERT INTO bursar_renewals (organization_id, award_id, chain_root_id, vendor_id, term_end,
                 notice_deadline, auto_renew, timezone, current_band, alerted_bands, status)
          VALUES (${orgId}, ${a.id}, ${a.chain_root_id}, ${a.vendor_id}, ${a.term_end},
                 ${noticeDeadline}, ${a.auto_renew}, ${a.timezone}, ${band},
                 ${JSON.stringify(due)}::jsonb, 'pending')
          ON CONFLICT (organization_id, award_id) DO NOTHING
        `);
      } else {
        await tx.execute(sql`
          UPDATE bursar_renewals
             SET notice_deadline = ${noticeDeadline}, current_band = ${band},
                 alerted_bands = ${JSON.stringify([...alerted, ...due])}::jsonb, updated_at = now()
           WHERE organization_id = ${orgId} AND id = ${existing.id}
        `);
      }

      for (const b of due) {
        fired += 1;
        // auto-renew-unreviewed absorbs a severity bump (spec 8): an auto-renewing contract nobody
        // decided is more urgent than one already reviewed.
        const severity = a.auto_renew && (!existing || existing.status === 'pending') ? 'high' : bandSeverity(b);
        await tx.execute(sql`
          INSERT INTO bursar_mismatches (organization_id, detector, severity, status, dedup_key,
                 evidence_hash, vendor_id, award_id, chain_root_id, basis, details, first_seen_at, last_seen_at)
          VALUES (${orgId}, 'renewal_cliff', ${severity}, 'open',
                 ${renewalDedup(a.id, b)}, ${b}, ${a.vendor_id}, ${a.id}, ${a.chain_root_id}, ${b},
                 ${JSON.stringify({ band: b, notice_deadline: noticeDeadline, auto_renew: a.auto_renew })}::jsonb,
                 now(), now())
          ON CONFLICT (organization_id, dedup_key) DO UPDATE SET last_seen_at = now(), severity = EXCLUDED.severity, updated_at = now()
        `);
        void publishBoltEvent(
          'renewal.approaching',
          'bursar',
          { 'renewal.id': existing?.id ?? a.id, 'award.id': a.id, band: b, 'org.id': orgId },
          orgId,
        ).catch(() => {});
      }
    }
    logger.info({ orgId, awards: awards.length, fired }, 'bursar-renewal-radar: org done');
    return { awards_scanned: awards.length, bands_fired: fired };
  });
}

function bandSeverity(band: string): string {
  if (band === 't_minus_7') return 'critical';
  if (band === 't_minus_30') return 'high';
  return 'medium';
}

function renewalDedup(awardId: string, band: string): string {
  // Stable per (award, band) so a re-scan updates the same finding (band idempotency).
  return createHash('sha256').update(`renewal_cliff${awardId}${band}`).digest('hex');
}
