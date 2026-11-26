// Personal-data commitment checks (spec 3.4, 7.2; the `verify-commitments` engine, row 106).
//
// Immutable holder rows carry only `personal_data_hmac` and `pd_hmac_key_id`; the names live in
// the mutable bastion_personal_data row. The audit packet records, per holder, whether the stored
// names still match the commitment. The HMAC key never leaves bastion-api, so the worker sends the
// holders here and gets one result each:
//
//   intact            the HMAC over the stored names equals the holder's commitment
//   pd_mismatch       the names were changed (or the row is gone) since the commitment
//   key_changed       the commitment was made under another key (BASTION_PD_HMAC_KEY changed)
//   redacted          the names were redacted on purpose (the commitment remains)
//   no_personal_data  the holder committed to no personal data

import type { BastionCommitmentHolder, BastionCommitmentResult, BastionPersonalDataHolderKind } from '@bigbluebam/shared';
import { type EngineDeps, orgTx, type Tx } from './context.js';

/** The immutable table behind each holder kind. One map, so a new holder kind fails to compile. */
const HOLDER_TABLE: Record<BastionPersonalDataHolderKind, string> = {
  snapshot: 'bastion_evidence_snapshots',
  manual_evidence: 'bastion_manual_evidence',
  feed_record: 'bastion_feed_records',
  attestation: 'bastion_policy_attestations',
  exception: 'bastion_exceptions',
};

export interface CommitmentFacts {
  holder_hmac: string | null;
  holder_key_id: string | null;
  pd: { data: unknown; redacted_at: unknown } | null;
}

/** Pure: the result for one holder. */
export function commitmentResult(f: CommitmentFacts | null, currentKeyId: string, hmac: (data: unknown) => string): BastionCommitmentResult {
  if (!f) return 'pd_mismatch';
  if (!f.holder_hmac) return 'no_personal_data';
  if (f.pd?.redacted_at) return 'redacted';
  if (f.holder_key_id !== currentKeyId) return 'key_changed';
  if (!f.pd) return 'pd_mismatch';
  return hmac(f.pd.data) === f.holder_hmac ? 'intact' : 'pd_mismatch';
}

async function factsFor(tx: Tx, orgId: string, kind: BastionPersonalDataHolderKind, ids: string[]): Promise<Map<string, CommitmentFacts>> {
  const table = HOLDER_TABLE[kind];
  const holders = await tx`
    SELECT h.id, h.personal_data_hmac, h.pd_hmac_key_id, p.data, p.redacted_at, (p.id IS NOT NULL) AS has_pd
      FROM ${tx(table)} h
      LEFT JOIN bastion_personal_data p
        ON p.organization_id = h.organization_id AND p.holder_kind = ${kind} AND p.holder_id = h.id
     WHERE h.organization_id = ${orgId} AND h.id = ANY(${ids}::uuid[])`;
  const out = new Map<string, CommitmentFacts>();
  for (const h of holders) {
    out.set(String(h.id), {
      holder_hmac: (h.personal_data_hmac as string | null) ?? null,
      holder_key_id: (h.pd_hmac_key_id as string | null) ?? null,
      pd: h.has_pd ? { data: h.data, redacted_at: h.redacted_at } : null,
    });
  }
  return out;
}

export async function verifyCommitments(
  deps: EngineDeps,
  orgId: string,
  holders: BastionCommitmentHolder[],
): Promise<{ results: Array<BastionCommitmentHolder & { result: BastionCommitmentResult }> }> {
  const byKind = new Map<BastionPersonalDataHolderKind, string[]>();
  for (const h of holders) byKind.set(h.holder_kind, [...(byKind.get(h.holder_kind) ?? []), h.holder_id]);
  const facts = await orgTx(deps.sql, orgId, async (tx) => {
    const m = new Map<string, CommitmentFacts>();
    for (const [kind, ids] of byKind) {
      for (const [id, f] of await factsFor(tx, orgId, kind, ids)) m.set(`${kind}:${id}`, f);
    }
    return m;
  });
  const results = holders.map((h) => ({
    ...h,
    result: commitmentResult(facts.get(`${h.holder_kind}:${h.holder_id}`) ?? null, deps.pdKeyId, deps.pdHmac),
  }));
  const counts: Record<string, number> = {};
  for (const r of results) counts[r.result] = (counts[r.result] ?? 0) + 1;
  deps.log.info({ organization_id: orgId, checked: results.length, ...counts }, `bastion-verify-commitments: checked ${results.length} holders`);
  return { results };
}
