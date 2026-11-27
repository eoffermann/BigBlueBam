// One open revision per check (#401), the rule both writers of a revision share.
//
// A confirmed check stays in force while a revision of it waits for review. Two revisions waiting
// on the same confirmed check would both "replace" it, and confirming one would leave the other a
// live proposal against a check that is already gone. So while one revision of a confirmed check
// is undecided, another is refused with REVISION_PENDING; the person or agent confirms, rejects or
// revises the waiting one instead.
//
// The writers, each of which locks the check being replaced FOR NO KEY UPDATE before looking for a
// waiting revision (the #393 lock pattern), so two revisions of one check serialize and the second
// sees the first. The lock is NO KEY UPDATE, never a full FOR UPDATE (#404): an evidence snapshot
// insert takes FOR KEY SHARE on the check through its FK, which FOR UPDATE blocks and NO KEY UPDATE
// does not, so a writer never waits on (or deadlocks with) the evaluator.
//   - services/assertions.service.ts reviseAssertionIn (POST /assertions/:id/revise, the MCP
//     bastion_propose_check revise path, and the policy pin in services/policy-pins.ts)
//   - services/fixes.service.ts applyApproval, config_change for a population-drift gap
// This module has no database imports so the engine-side writer (fixes.service.ts, raw SQL) and
// the drizzle-side writer share the rule without sharing a connection pool.

import { ConflictError } from './errors.js';

export const REVISION_PENDING_CODE = 'REVISION_PENDING';

export const REVISION_PENDING_MESSAGE =
  'This check already has a change waiting for review. Confirm, reject or revise that change instead of starting another.';

export function revisionPendingError(): ConflictError {
  return new ConflictError(REVISION_PENDING_MESSAGE, REVISION_PENDING_CODE);
}
