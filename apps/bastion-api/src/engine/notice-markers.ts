// Durable "this notice already went out" markers (issue #243, migration 0287).
//
// The bastion_outbox idempotency key is only a dedupe for as long as the row exists, and
// bastion-retention prunes delivered rows after RETENTION_DONE_DAYS (30). Any notice whose dedupe
// window is longer than that (a yearly attestation nudge, an evaluation.missed that stays true for
// weeks, a ledger chain break that never heals) must claim one of these markers in the same
// transaction as the event and enqueue only when the claim succeeds. Retention never touches them.

import type { Tx } from './context.js';

/**
 * Claim a one-shot notice. True exactly once per (org, key), ever; false on every later call.
 */
export async function claimNoticeOnce(tx: Tx, orgId: string, key: string, now: Date): Promise<boolean> {
  const r = await tx`
    INSERT INTO bastion_notice_markers (organization_id, marker_key, first_sent_at, last_sent_at, sent_count)
    VALUES (${orgId}, ${key}, ${now}, ${now}, 1)
    ON CONFLICT (organization_id, marker_key) DO NOTHING
    RETURNING sent_count`;
  return r.length > 0;
}

/**
 * Claim a recurring notice: granted when the key was never sent, or when its last send is at least
 * `everyMs` old (anchored to the last send, not to an epoch-aligned bucket). Returns the send
 * number (1, 2, ...) when granted, else null.
 */
export async function claimNoticeEvery(tx: Tx, orgId: string, key: string, now: Date, everyMs: number): Promise<number | null> {
  const rearmBefore = new Date(now.getTime() - everyMs);
  const r = await tx`
    INSERT INTO bastion_notice_markers (organization_id, marker_key, first_sent_at, last_sent_at, sent_count)
    VALUES (${orgId}, ${key}, ${now}, ${now}, 1)
    ON CONFLICT (organization_id, marker_key) DO UPDATE
       SET last_sent_at = EXCLUDED.last_sent_at, sent_count = bastion_notice_markers.sent_count + 1
     WHERE bastion_notice_markers.last_sent_at <= ${rearmBefore}
    RETURNING sent_count`;
  return r[0] ? Number(r[0].sent_count) : null;
}
