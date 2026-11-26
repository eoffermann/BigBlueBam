// Answer-library staleness (spec 2.7 step 8). An approved answer is marked stale when a control it
// cites changes its STORED status. It is never marked on `evaluation_stale`, which is computed at
// read time, so one missed night cannot stale the whole library. Called by the evaluator in the
// transaction that writes the new stored status.

import type { Tx } from './context.js';

/** The stale_reason recorded on each answer (varchar(128)). */
export function libraryStaleReason(from: string, to: string): string {
  return `control_status_changed:${from}:${to}`.slice(0, 128);
}

export async function markAnswersStaleForControl(tx: Tx, orgId: string, controlId: string, from: string, to: string): Promise<number> {
  if (from === to) return 0;
  const cited = JSON.stringify([{ entity_type: 'bastion.control', entity_id: controlId }]);
  const r = await tx`
    UPDATE bastion_answer_library SET stale = true, stale_reason = ${libraryStaleReason(from, to)}
     WHERE organization_id = ${orgId} AND retired_at IS NULL AND NOT stale AND cited_refs @> ${cited}::jsonb
    RETURNING id`;
  return r.length;
}
