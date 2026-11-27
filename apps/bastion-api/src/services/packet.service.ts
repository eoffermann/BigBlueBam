// The audit packet's bastion-api side (spec 7.2; the `export-packet` engine, row 106; M9).
//
// The worker builds and streams the zip (it is the only worker job that touches the Bastion
// bucket), but WHAT goes in it is decided here, once: the controls and their state words come from
// the same builder as the auditor room (audit-view.ts), the evidence and files from the same rules
// (period, restricted allowlist, redaction), and the personal-data commitments are checked by the
// verify-commitments engine (the HMAC key never leaves bastion-api).
//
//   claim     queued -> running for one claimant; returns the contents to write, or fails the
//             packet with a plain reason (an ISO packet with an unfinished SoA, a vanished
//             framework). A running packet whose heartbeat is stale may be re-claimed.
//   progress  stage + count, heartbeat; fenced on the claimant (false = the claim was lost)
//   finish    succeeded with the object key, its SHA-256 and size
//   fail      failed with a plain error

import { toCsv, type BastionExportPacketEngine, type BastionPacketClaim, type BastionPacketContents } from '@bigbluebam/shared';
import { type EngineDeps, orgTx, type Tx } from '../engine/context.js';
import { frameworkTemplate } from '../library/index.js';
import { assertSoaCompleteForPacket, SoaIncompleteError } from '../library/soa.js';
import { runInOrgScope } from '../plugins/rls.js';
import { auditControls, loadAuditFramework, restoreNotices, sealHistory, soaFor } from './audit-view.js';
import { soaLinks } from './frameworks.service.js';
import { packetObjectKey } from './sharing.service.js';

/** A running packet whose heartbeat is older than this may be re-claimed (and is reaped). */
export const PACKET_LEASE_MS = 10 * 60_000;
/** A packet nobody claimed within this time is failed by the reaper ("build it again"). */
export const PACKET_START_TIMEOUT_MS = 30 * 60_000;

const EXT: Record<string, string> = {
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'application/json': '.json',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'application/zip': '.zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
};

/** A zip entry name: printable ASCII, no separators, bounded. */
export function entryName(s: string, fallback: string): string {
  const cleaned = s
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\/:*?<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned.length > 0 ? cleaned : fallback;
}

const day = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 10) : '');

async function packetContents(tx: Tx, p: Record<string, unknown>, now: Date): Promise<Omit<BastionPacketContents, 'soa_csv' | 'restore_notices'>> {
  const orgId = String(p.organization_id);
  const fw = await loadAuditFramework(tx, orgId, String(p.framework_id));
  if (!fw) throw new PacketRefused('The framework for this packet was archived or removed.');
  const controls = await auditControls(tx, orgId, fw.id, now);
  const ids = controls.map((c) => c.control_id);
  const periodStart = String(p.period_start);
  const periodEnd = String(p.period_end);
  const includeRestricted = !!p.include_restricted;

  const snaps = await tx`
    SELECT s.id, c.control_key, s.outcome, s.unprovable_reason, s.created_at, s.content_sha256, o.object_key, o.bytes_redacted_at
      FROM bastion_evidence_snapshots s
      JOIN bastion_controls c ON c.id = s.control_id AND c.organization_id = s.organization_id
      LEFT JOIN bastion_evidence_objects o ON o.organization_id = s.organization_id AND o.content_sha256 = s.content_sha256
     WHERE s.organization_id = ${orgId} AND s.control_id = ANY(${ids}::uuid[])
       AND s.created_at::date >= ${periodStart}::date AND s.created_at::date <= ${periodEnd}::date
     ORDER BY c.control_key, s.created_at, s.id`;
  const files = await tx`
    SELECT e.id, e.title, e.kind, e.sensitivity, e.content_sha256, e.content_type, e.redacted_at, e.personal_data_hmac,
           o.object_key, o.size_bytes, o.bytes_redacted_at,
           array_agg(DISTINCT c.control_key ORDER BY c.control_key) AS control_keys
      FROM bastion_manual_evidence e
      JOIN bastion_manual_evidence_links l ON l.organization_id = e.organization_id AND l.manual_evidence_id = e.id AND l.unlinked_at IS NULL
      JOIN bastion_assertions a ON a.organization_id = l.organization_id AND a.id = l.assertion_id
      JOIN bastion_controls c ON c.id = a.control_id AND c.organization_id = a.organization_id
      LEFT JOIN bastion_evidence_objects o ON o.organization_id = e.organization_id AND o.content_sha256 = e.content_sha256
     WHERE e.organization_id = ${orgId} AND a.control_id = ANY(${ids}::uuid[]) AND e.status IN ('active', 'superseded')
       ${includeRestricted ? tx`` : tx`AND e.sensitivity = 'standard'`}
       AND coalesce(e.produced_on, e.created_at::date) <= ${periodEnd}::date
       AND (e.valid_until IS NULL OR e.valid_until::date >= ${periodStart}::date)
     GROUP BY e.id, o.object_key, o.size_bytes, o.bytes_redacted_at
     ORDER BY e.title`;
  const attestations = await tx`
    SELECT t.id, coalesce(pol.title_cache, 'Policy') AS policy_title, t.beacon_version, t.attested_at, t.body_sha256,
           pd.data AS pd, pd.redacted_at AS pd_redacted
      FROM bastion_policy_attestations t
      JOIN bastion_policies pol ON pol.id = t.policy_id AND pol.organization_id = t.organization_id
      LEFT JOIN bastion_personal_data pd ON pd.organization_id = t.organization_id AND pd.holder_kind = 'attestation' AND pd.holder_id = t.id
     WHERE t.organization_id = ${orgId} AND t.attested_at::date >= ${periodStart}::date AND t.attested_at::date <= ${periodEnd}::date
     ORDER BY t.attested_at`;
  const exceptions = await tx`
    SELECT e.id, c.control_key, c.title, e.scope, e.reason, e.compensating_note, e.status, e.decided_at, e.expires_at,
           e.small_team_self_approval, e.personal_data_hmac
      FROM bastion_exceptions e JOIN bastion_controls c ON c.id = e.control_id AND c.organization_id = e.organization_id
     WHERE e.organization_id = ${orgId} AND e.control_id = ANY(${ids}::uuid[]) AND e.status IN ('active', 'expired')
       AND e.decided_at::date <= ${periodEnd}::date AND e.expires_at::date >= ${periodStart}::date
     ORDER BY e.decided_at`;
  const drift = await tx`
    SELECT c.control_key, c.title, d.from_status, d.to_status, d.reason, d.detected_at, d.task_status, d.acknowledged_at
      FROM bastion_drift_events d JOIN bastion_controls c ON c.id = d.control_id AND c.organization_id = d.organization_id
     WHERE d.organization_id = ${orgId} AND d.control_id = ANY(${ids}::uuid[])
       AND d.detected_at::date >= ${periodStart}::date AND d.detected_at::date <= ${periodEnd}::date
     ORDER BY d.detected_at`;
  const pdSnapshots = await tx`
    SELECT s.id FROM bastion_evidence_snapshots s
     WHERE s.organization_id = ${orgId} AND s.control_id = ANY(${ids}::uuid[]) AND s.personal_data_hmac IS NOT NULL
       AND s.created_at::date >= ${periodStart}::date AND s.created_at::date <= ${periodEnd}::date`;
  const seals = await sealHistory(tx, orgId);
  const org = (await tx`SELECT name FROM organizations WHERE id = ${orgId}`)[0];

  const holders: BastionPacketContents['holders'] = [
    ...pdSnapshots.map((s) => ({ holder_kind: 'snapshot' as const, holder_id: String(s.id) })),
    ...files.filter((f) => f.personal_data_hmac).map((f) => ({ holder_kind: 'manual_evidence' as const, holder_id: String(f.id) })),
    ...attestations.map((a) => ({ holder_kind: 'attestation' as const, holder_id: String(a.id) })),
    ...exceptions.filter((e) => e.personal_data_hmac).map((e) => ({ holder_kind: 'exception' as const, holder_id: String(e.id) })),
  ];

  return {
    packet: {
      id: String(p.id),
      organization_id: orgId,
      period_start: periodStart,
      period_end: periodEnd,
      include_restricted: includeRestricted,
      max_packet_bytes: Number(p.max_packet_bytes),
      object_key: packetObjectKey(orgId, String(p.id)),
    },
    organization_name: String(org?.name ?? ''),
    framework: fw,
    generated_at: now.toISOString(),
    controls: controls.map(({ control_id: _id, ...c }) => c),
    evidence: snaps.map((s) => ({
      snapshot_id: String(s.id),
      control_key: String(s.control_key),
      outcome: String(s.outcome),
      reason: (s.unprovable_reason as string | null) ?? null,
      recorded_at: new Date(s.created_at as string).toISOString(),
      object_key: (s.object_key as string | null) ?? null,
      content_sha256: String(s.content_sha256),
      redacted: !!s.bytes_redacted_at,
      path: `evidence/${entryName(String(s.control_key), 'control')}/${day(s.created_at)}-${String(s.id).slice(0, 8)}.json`,
    })),
    files: files.map((f) => {
      const keys = (f.control_keys as string[] | null) ?? [];
      const ext = f.kind === 'attestation_statement' ? '.txt' : (EXT[String(f.content_type ?? '').split(';')[0]?.trim().toLowerCase() ?? ''] ?? '');
      return {
        manual_evidence_id: String(f.id),
        title: String(f.title),
        kind: String(f.kind),
        control_keys: keys,
        object_key: (f.object_key as string | null) ?? null,
        content_sha256: (f.content_sha256 as string | null) ?? null,
        size_bytes: f.size_bytes == null ? null : Number(f.size_bytes),
        restricted: f.sensitivity === 'restricted',
        redacted: !!(f.redacted_at || f.bytes_redacted_at),
        path: `uploaded/${entryName(keys[0] ?? 'unlinked', 'unlinked')}/${entryName(String(f.title), 'evidence')}-${String(f.id).slice(0, 8)}${ext}`,
      };
    }),
    attestations_csv: toCsv(
      ['policy', 'version', 'person', 'read on', 'body sha256'],
      attestations.map((a) => [
        a.policy_title,
        a.beacon_version,
        a.pd_redacted ? '(redacted)' : ((a.pd as { name?: string } | null)?.name ?? ''),
        new Date(a.attested_at as string).toISOString(),
        a.body_sha256,
      ]),
    ),
    exceptions_csv: toCsv(
      ['control', 'title', 'scope', 'reason', 'compensating measure', 'status', 'approved on', 'expires on', 'small-team self approval'],
      exceptions.map((e) => [
        e.control_key,
        e.title,
        e.scope,
        e.reason,
        e.compensating_note ?? '',
        e.status,
        day(e.decided_at),
        day(e.expires_at),
        e.small_team_self_approval ? 'yes' : 'no',
      ]),
    ),
    drift_csv: toCsv(
      ['control', 'title', 'from', 'to', 'why', 'detected at', 'task', 'acknowledged at'],
      drift.map((d) => [
        d.control_key,
        d.title,
        d.from_status,
        d.to_status,
        d.reason,
        new Date(d.detected_at as string).toISOString(),
        d.task_status,
        d.acknowledged_at ? new Date(d.acknowledged_at as string).toISOString() : '',
      ]),
    ),
    seals: seals.seals,
    public_keys: seals.public_keys,
    holders,
  };
}

class PacketRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PacketRefused';
  }
}

async function failPacket(deps: EngineDeps, orgId: string, packetId: string, claimant: string | null, error: string): Promise<void> {
  await orgTx(deps.sql, orgId, (tx) => tx`
    UPDATE bastion_export_packets SET status = 'failed', error = ${error.slice(0, 2000)}, heartbeat_at = ${deps.now()}
     WHERE organization_id = ${orgId} AND id = ${packetId} AND status IN ('queued', 'running')
       ${claimant ? tx`AND (claimed_by IS NULL OR claimed_by = ${claimant})` : tx``}`);
}

/** The export-packet engine. */
export async function exportPacketEngine(deps: EngineDeps, body: BastionExportPacketEngine): Promise<BastionPacketClaim | { ok: boolean }> {
  const orgId = body.organization_id;
  const now = deps.now();
  if (body.action === 'claim') {
    const staleBefore = new Date(now.getTime() - PACKET_LEASE_MS);
    const claimed = await orgTx(deps.sql, orgId, async (tx) => {
      const [p] = await tx`
        UPDATE bastion_export_packets p
           SET status = 'running', claimed_by = ${body.claimant}, heartbeat_at = ${now}, stage = 'collecting', stage_progress = 0,
               object_key = ${packetObjectKey(orgId, body.packet_id)}, error = NULL
         WHERE p.organization_id = ${orgId} AND p.id = ${body.packet_id}
           AND (p.status = 'queued' OR (p.status = 'running' AND (p.claimed_by = ${body.claimant} OR p.heartbeat_at < ${staleBefore})))
        RETURNING p.id, p.organization_id, p.framework_id, p.period_start::text AS period_start, p.period_end::text AS period_end,
                  p.include_restricted,
                  (SELECT s.max_packet_bytes FROM bastion_org_settings s WHERE s.organization_id = p.organization_id) AS max_packet_bytes`;
      if (!p) {
        const cur = (await tx`SELECT status FROM bastion_export_packets WHERE organization_id = ${orgId} AND id = ${body.packet_id}`)[0];
        return { row: null, status: (cur?.status as string | undefined) ?? null };
      }
      return { row: p as Record<string, unknown>, status: 'running' };
    });
    if (!claimed.row) {
      return { claimed: false, status: (claimed.status ?? 'failed') as BastionPacketClaim['status'], error: claimed.status ? null : 'We could not find that packet.', contents: null };
    }
    const p = claimed.row;
    try {
      deps.log.info({ organization_id: orgId, packet_id: body.packet_id }, 'bastion-export-packet: collecting controls');
      const fw = await orgTx(deps.sql, orgId, (tx) => loadAuditFramework(tx, orgId, String(p.framework_id)));
      if (!fw) throw new PacketRefused('The framework for this packet was archived or removed.');
      const template = frameworkTemplate(fw.template_key);
      if (template?.is_iso) {
        const links = await runInOrgScope(orgId, (tx) => soaLinks(tx, orgId, fw.id));
        try {
          assertSoaCompleteForPacket(template, links);
        } catch (err) {
          if (err instanceof SoaIncompleteError) throw new PacketRefused(err.message);
          throw err;
        }
      }
      const contents = await orgTx(deps.sql, orgId, (tx) => packetContents(tx, p, now));
      const soa = await soaFor(orgId, fw);
      const notices = await restoreNotices(deps, orgId);
      deps.log.info(
        { organization_id: orgId, packet_id: body.packet_id, controls: contents.controls.length, evidence: contents.evidence.length, files: contents.files.length },
        'bastion-export-packet: contents ready for the worker',
      );
      return { claimed: true, status: 'running', error: null, contents: { ...contents, soa_csv: soa?.csv ?? null, restore_notices: notices } };
    } catch (err) {
      const msg = err instanceof PacketRefused ? err.message : 'The packet could not be prepared. Try building it again.';
      if (!(err instanceof PacketRefused)) deps.log.error({ organization_id: orgId, packet_id: body.packet_id, err: (err as Error).message }, 'bastion-export-packet: claim failed');
      await failPacket(deps, orgId, body.packet_id, body.claimant, msg);
      return { claimed: false, status: 'failed', error: msg, contents: null };
    }
  }
  if (body.action === 'progress') {
    const rows = await orgTx(deps.sql, orgId, (tx) => tx`
      UPDATE bastion_export_packets SET stage = ${body.stage}, stage_progress = ${body.progress}, heartbeat_at = ${now}
       WHERE organization_id = ${orgId} AND id = ${body.packet_id} AND status = 'running' AND claimed_by = ${body.claimant}
      RETURNING id`);
    return { ok: rows.length > 0 };
  }
  if (body.action === 'finish') {
    const rows = await orgTx(deps.sql, orgId, (tx) => tx`
      UPDATE bastion_export_packets
         SET status = 'succeeded', stage = NULL, stage_progress = 0, object_key = ${body.object_key},
             content_sha256 = ${body.content_sha256}, size_bytes = ${body.size_bytes}, heartbeat_at = ${now}, error = NULL
       WHERE organization_id = ${orgId} AND id = ${body.packet_id} AND status = 'running' AND claimed_by = ${body.claimant}
      RETURNING id`);
    deps.log.info({ organization_id: orgId, packet_id: body.packet_id, size_bytes: body.size_bytes, ok: rows.length > 0 }, 'bastion-export-packet: finished');
    return { ok: rows.length > 0 };
  }
  await failPacket(deps, orgId, body.packet_id, body.claimant, body.error);
  return { ok: true };
}

/** run-reaper's packet half: stale running packets and packets nobody started are failed. */
export async function reapPackets(deps: EngineDeps, opts: { organization_id?: string } = {}): Promise<{ failed: number }> {
  const now = deps.now().getTime();
  const rows = await deps.sql`
    SELECT organization_id, id, status FROM bastion_export_packets
     WHERE ((status = 'running' AND heartbeat_at < ${new Date(now - PACKET_LEASE_MS)})
        OR (status = 'queued' AND created_at < ${new Date(now - PACKET_START_TIMEOUT_MS)}))
       ${opts.organization_id ? deps.sql`AND organization_id = ${opts.organization_id}` : deps.sql``}
     LIMIT 200`;
  for (const r of rows) {
    await failPacket(
      deps,
      String(r.organization_id),
      String(r.id),
      null,
      r.status === 'queued' ? 'The packet build did not start. Build it again.' : 'The packet build stopped. Build it again.',
    );
  }
  if (rows.length > 0) deps.log.info({ failed: rows.length }, 'bastion-run-reaper: failed stalled audit packets');
  return { failed: rows.length };
}
