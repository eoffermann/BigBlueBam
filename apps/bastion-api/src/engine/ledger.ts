// Ledger appends (spec 3.4). Serialized per org with pg_advisory_xact_lock under SET LOCAL
// lock_timeout = '3s' (a timeout ends the slice cleanly); no outbound HTTP inside.
//
// Numbering: seq never repeats within an org. After a detected restore the next entry uses the
// provisional epoch and continues above the highest bucket-sealed head_seq, so no sealed
// (epoch, seq) is ever reused, acknowledged or not.

import { compareEpochSeq, entryHash, GENESIS_HASH, toRecordedAt } from '../lib/ledger-canonical.js';
import { LEDGER_LOCK_TIMEOUT_MS } from './budgets.js';
import { sqlstateOf, type Tx } from './context.js';
import type { SealIdentity } from './restore.js';

export class AppendBlockedError extends Error {
  constructor(public readonly restoreId: string) {
    super('Ledger appends are paused until an owner resolves a detected restore.');
    this.name = 'AppendBlockedError';
  }
}

export class RestoreDetectedError extends Error {
  constructor() {
    super('The ledger no longer matches the newest bucket seal.');
    this.name = 'RestoreDetectedError';
  }
}

export class LedgerLockTimeoutError extends Error {
  constructor() {
    super('Timed out waiting for the ledger lock.');
    this.name = 'LedgerLockTimeoutError';
  }
}

/** Take the per-org ledger lock inside the caller's transaction (lock_timeout 3 s). */
export async function lockLedger(tx: Tx, orgId: string): Promise<void> {
  await tx.unsafe(`SET LOCAL lock_timeout = '${LEDGER_LOCK_TIMEOUT_MS}ms'`);
  try {
    await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`bastion_ledger:${orgId}`}, 0))`;
  } catch (err) {
    if (sqlstateOf(err) === '55P03') throw new LedgerLockTimeoutError();
    throw err;
  }
}

export interface NewEntry {
  kind: 'snapshot' | 'manual_evidence' | 'withdrawal' | 'feed_record' | 'attestation' | 'exception' | 'redaction' | 'restore';
  id: string;
  content_sha256: string | null;
  personal_data_hmac: string | null;
  pd_hmac_key_id: string | null;
}

export interface AppendedEntry extends NewEntry {
  epoch: number;
  seq: number;
  entry_hash: string;
}

/**
 * Append entries for one org. The caller has already run checkLedgerIdentity for this batch
 * (outside any transaction) and passes the highest bucket seal it saw; inside the lock this
 * re-checks the cheap SQL parts: no unresolved restore, and the sealed entry still matches.
 * `allowUnresolvedRestore` is only for the acknowledgement that appends the `restore` entry.
 */
export async function appendLedger(
  tx: Tx,
  orgId: string,
  entries: NewEntry[],
  ctx: { highest: SealIdentity | null; now: Date; skipLock?: boolean },
): Promise<AppendedEntry[]> {
  if (!ctx.skipLock) await lockLedger(tx, orgId);
  const unresolved = await tx`SELECT id FROM bastion_ledger_restores
                               WHERE organization_id = ${orgId} AND resolution IS NULL LIMIT 1`;
  if (unresolved[0]) throw new AppendBlockedError(unresolved[0].id as string);

  const head = (
    await tx`SELECT epoch, seq, entry_hash FROM bastion_ledger_entries
              WHERE organization_id = ${orgId} ORDER BY seq DESC LIMIT 1`
  )[0];
  const latestRestore = (
    await tx`SELECT provisional_epoch, bucket_head_seq, bucket_epoch, bucket_head_hash FROM bastion_ledger_restores
              WHERE organization_id = ${orgId} ORDER BY provisional_epoch DESC, detected_at DESC LIMIT 1`
  )[0];

  const highest = ctx.highest;
  if (highest) {
    const sealed = (
      await tx`SELECT epoch, entry_hash FROM bastion_ledger_entries
                WHERE organization_id = ${orgId} AND seq = ${highest.head_seq}`
    )[0];
    const matches = !!sealed && Number(sealed.epoch) === highest.epoch && sealed.entry_hash === highest.head_hash;
    const explained =
      !!latestRestore &&
      Number(latestRestore.bucket_epoch) === highest.epoch &&
      Number(latestRestore.bucket_head_seq) === highest.head_seq &&
      latestRestore.bucket_head_hash === highest.head_hash;
    if (!matches && !explained) throw new RestoreDetectedError();
  }

  let epoch = Math.max(head ? Number(head.epoch) : 1, latestRestore ? Number(latestRestore.provisional_epoch) : 1);
  let seq =
    Math.max(
      head ? Number(head.seq) : 0,
      highest ? highest.head_seq : 0,
      latestRestore ? Number(latestRestore.bucket_head_seq) : 0,
    ) + 1;
  if (highest && compareEpochSeq({ epoch, seq }, { epoch: highest.epoch, seq: highest.head_seq }) <= 0) {
    // Defensive: never write at or below a sealed identity.
    epoch = highest.epoch;
    seq = highest.head_seq + 1;
  }
  let prev = head ? (head.entry_hash as string) : GENESIS_HASH;
  const out: AppendedEntry[] = [];
  for (const e of entries) {
    const recordedAt = toRecordedAt(ctx.now);
    const hash = entryHash({
      org: orgId,
      epoch,
      seq,
      kind: e.kind,
      id: e.id,
      content_sha256: e.content_sha256,
      personal_data_hmac: e.personal_data_hmac,
      pd_hmac_key_id: e.pd_hmac_key_id,
      prev,
      recorded_at: recordedAt,
    });
    await tx`
      INSERT INTO bastion_ledger_entries
        (organization_id, epoch, seq, entry_kind, entry_id, content_sha256, personal_data_hmac, pd_hmac_key_id,
         prev_entry_hash, entry_hash, recorded_at)
      VALUES (${orgId}, ${epoch}, ${seq}, ${e.kind}, ${e.id}, ${e.content_sha256}, ${e.personal_data_hmac},
              ${e.pd_hmac_key_id}, ${prev}, ${hash}, ${recordedAt}::timestamptz)`;
    out.push({ ...e, epoch, seq, entry_hash: hash });
    prev = hash;
    seq += 1;
  }
  return out;
}
