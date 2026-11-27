// What an auditor sees (spec 5.2, 7.2; M9). ONE builder feeds the public auditor room, the
// creator's Preview and the audit packet, so the three can never disagree about a control's state
// words, its requirement codes, the accepted risks, the Statement of Applicability, the seal
// history or the restore notices. The control states come from the Readiness loader
// (engine/numbers.ts loadControlStates), so the room's words match Readiness too.

import { BASTION_ROOM_STATE_WORDS, type BastionRoomControlState } from '@bigbluebam/shared';
import type { EngineDeps, Tx } from '../engine/context.js';
import { type ControlVerdict, loadControlStates } from '../engine/numbers.js';
import { bucketRestoreRecords } from '../engine/restore.js';
import { publishedSealKeys } from '../lib/keys.js';
import { frameworkTemplate } from '../library/index.js';
import { soaCsv, soaRows, type SoaRow } from '../library/soa.js';
import { runInOrgScope } from '../plugins/rls.js';
import { REASON_WORDS } from './coverage.service.js';
import { soaLinks } from './frameworks.service.js';

/** The auditor-facing state of one control (spec 2.3: unassessed controls read "Not assessed"). */
export function roomStateOf(v: ControlVerdict): BastionRoomControlState {
  if (v.bucket === 'not_set_up' || v.reason === 'not_yet_confirmed') return 'not_assessed';
  if (v.state === 'pass') return 'met';
  if (v.state === 'pass_with_exception') return 'risk_accepted';
  if (v.state === 'fail') return 'not_met';
  return 'cant_prove';
}

export interface AuditControlRow {
  control_id: string;
  control_key: string;
  title: string;
  category: string | null;
  owner: string | null;
  state: BastionRoomControlState;
  state_words: string;
  reason: string | null;
  requirement_codes: string[];
  last_evaluated_at: string | null;
}

export interface AuditFramework {
  id: string;
  name: string;
  template_key: string;
  is_iso: boolean;
}

export async function loadAuditFramework(tx: Tx, orgId: string, frameworkId: string): Promise<AuditFramework | null> {
  const f = (await tx`SELECT id, name, template_key FROM bastion_frameworks
                       WHERE organization_id = ${orgId} AND id = ${frameworkId} AND status <> 'archived'`)[0];
  if (!f) return null;
  return { id: String(f.id), name: String(f.name), template_key: String(f.template_key), is_iso: !!frameworkTemplate(String(f.template_key))?.is_iso };
}

/**
 * Every applicable control of a framework with its state words, optionally narrowed to a room's
 * frozen control list. Not-applicable controls never appear (the SoA explains them).
 */
export async function auditControls(tx: Tx, orgId: string, frameworkId: string, now: Date, only: readonly string[] | null = null): Promise<AuditControlRow[]> {
  const states = await loadControlStates(tx, orgId, now, frameworkId);
  const keep = only ? new Set(only) : null;
  const controls = states.controls.filter((c) => !keep || keep.has(c.control_id));
  const reqs = await tx`
    SELECT control_id, array_agg(DISTINCT ref_code ORDER BY ref_code) AS codes
      FROM bastion_control_requirements
     WHERE organization_id = ${orgId} AND framework_id = ${frameworkId} AND removed_at IS NULL AND applicability = 'applicable'
     GROUP BY control_id`;
  const codes = new Map(reqs.map((r) => [String(r.control_id), (r.codes as string[]) ?? []]));
  const exByControl = new Map<string, Date>();
  for (const e of states.exceptions) {
    if (!e.control_id) continue;
    const prev = exByControl.get(e.control_id);
    if (!prev || e.expires_at < prev) exByControl.set(e.control_id, e.expires_at);
  }
  return controls.map((c) => {
    const state = roomStateOf(c.verdict);
    let reason: string | null = null;
    if (state === 'cant_prove' && c.verdict.reason) reason = REASON_WORDS[c.verdict.reason] ?? null;
    if (state === 'not_assessed') reason = 'Nobody has set up how to check this yet.';
    if (state === 'risk_accepted') {
      const until = exByControl.get(c.control_id);
      reason = until ? `The owner accepted this risk until ${until.toISOString().slice(0, 10)}.` : 'The owner accepted this risk.';
    }
    return {
      control_id: c.control_id,
      control_key: c.control_key,
      title: c.title,
      category: c.category,
      owner: c.owner_name,
      state,
      state_words: BASTION_ROOM_STATE_WORDS[state],
      reason,
      requirement_codes: codes.get(c.control_id) ?? [],
      last_evaluated_at: c.last_evaluated_at ? c.last_evaluated_at.toISOString() : null,
    };
  });
}

export function stateCounts(rows: AuditControlRow[]): Record<BastionRoomControlState, number> & { total: number } {
  const out = { met: 0, not_met: 0, risk_accepted: 0, cant_prove: 0, not_assessed: 0, total: rows.length };
  for (const r of rows) out[r.state] += 1;
  return out;
}

/** Active accepted risks on the given controls: what, until when, and whose control it is. */
export async function acceptedRisks(tx: Tx, orgId: string, controlIds: readonly string[]) {
  if (controlIds.length === 0) return [];
  const rows = await tx`
    SELECT e.id, e.reason, e.compensating_note, e.expires_at, c.control_key, c.title, u.display_name AS owner
      FROM bastion_exceptions e
      JOIN bastion_controls c ON c.id = e.control_id AND c.organization_id = e.organization_id
      LEFT JOIN users u ON u.id = c.owner_user_id
     WHERE e.organization_id = ${orgId} AND e.status = 'active' AND e.control_id = ANY(${[...controlIds]}::uuid[])
     ORDER BY e.expires_at`;
  return rows.map((r) => ({
    id: String(r.id),
    control_key: String(r.control_key),
    control_title: String(r.title),
    reason: String(r.reason),
    compensating_note: (r.compensating_note as string | null) ?? null,
    expires_at: new Date(r.expires_at as string).toISOString(),
    owner: (r.owner as string | null) ?? null,
  }));
}

/** The signed daily seals, newest first, and every public key that ever signed one (spec 3.4). */
export async function sealHistory(tx: Tx, orgId: string, limit = 400) {
  const seals = await tx`
    SELECT seal_date::text AS seal_date, epoch, head_seq, head_hash, signature, signing_key_id
      FROM bastion_ledger_seals WHERE organization_id = ${orgId}
     ORDER BY seal_date DESC LIMIT ${limit}`;
  return {
    seals: seals.map((s) => ({
      seal_date: String(s.seal_date),
      epoch: Number(s.epoch),
      head_seq: Number(s.head_seq),
      head_hash: String(s.head_hash),
      signature: String(s.signature),
      signing_key_id: String(s.signing_key_id),
    })),
    public_keys: publishedSealKeys(),
  };
}

/**
 * Every lost range, read from the bucket records (they survive a database rewrite), worded for an
 * auditor: "History lost by restore, epoch E entries X to Y" or "Unexplained gap, ...".
 */
export async function restoreNotices(deps: EngineDeps, orgId: string): Promise<string[]> {
  // Only records whose signature verifies (#208): a planted object never reaches an auditor.
  const { records } = await bucketRestoreRecords(deps, orgId).catch(() => ({ records: [] }));
  const out: string[] = [];
  for (const r of records) {
    const epoch = r.bucket_epoch ?? '?';
    const range = r.lost_from_seq != null && r.lost_to_seq != null ? `entries ${r.lost_from_seq} to ${r.lost_to_seq}` : 'some entries';
    if (r.status === 'acknowledged' && r.resolution === 'restore_acknowledged') out.push(`History lost by restore, epoch ${epoch} ${range}`);
    else if (r.status === 'pending_ack') out.push(`History lost by restore (awaiting the owner's acknowledgement), epoch ${epoch} ${range}`);
    else out.push(`Unexplained gap, epoch ${epoch} ${range}`);
  }
  return out;
}

/** The Statement of Applicability rows and csv for an ISO framework (null otherwise). */
export async function soaFor(orgId: string, framework: AuditFramework): Promise<{ rows: SoaRow[]; csv: string } | null> {
  const template = frameworkTemplate(framework.template_key);
  if (!template?.is_iso) return null;
  const links = await runInOrgScope(orgId, (tx) => soaLinks(tx, orgId, framework.id));
  return { rows: soaRows(template, links), csv: soaCsv(template, links) };
}
