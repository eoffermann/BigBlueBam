// The start of every ledger-append batch outside the evaluator (manual evidence, feed records,
// withdrawals, redactions; spec 3.4): the restore-detection identity check runs first, outside any
// transaction, and its typed failures become plain API errors.

import { ConflictError, UnavailableError } from '../lib/errors.js';
import type { EngineDeps } from '../engine/context.js';
import { AppendBlockedError, LedgerLockTimeoutError, RestoreDetectedError } from '../engine/ledger.js';
import { checkLedgerIdentity, type SealIdentity, StorageUnavailableError } from '../engine/restore.js';

export const LEDGER_PAUSED =
  'Evidence recording is paused: Bastion found that its history does not match its last daily seal (for example after a database restore). An owner can resolve this under Settings, Evidence integrity.';

/** Run the identity check; returns the highest bucket seal to pass to appendLedger. */
export async function beginLedgerBatch(deps: EngineDeps, orgId: string): Promise<SealIdentity | null> {
  try {
    const ident = await checkLedgerIdentity(deps, orgId);
    if (ident.blockedBy) throw new ConflictError(LEDGER_PAUSED, 'LEDGER_PAUSED');
    return ident.highest;
  } catch (err) {
    if (err instanceof StorageUnavailableError) {
      throw new UnavailableError("Evidence storage isn't reachable right now, so nothing was recorded. Try again in a few minutes.", 'STORAGE_UNAVAILABLE');
    }
    throw err;
  }
}

/** Map an append failure inside a transaction onto the API error the caller sees. */
export function mapAppendError(err: unknown): unknown {
  if (err instanceof AppendBlockedError || err instanceof RestoreDetectedError) return new ConflictError(LEDGER_PAUSED, 'LEDGER_PAUSED');
  if (err instanceof LedgerLockTimeoutError) {
    return new UnavailableError('Bastion is busy recording other evidence. Try again in a moment.', 'LEDGER_BUSY');
  }
  return err;
}
