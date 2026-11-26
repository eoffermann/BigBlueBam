// bastion_audit_log writes from the raw (engine) postgres client, inside the caller's org-scoped
// transaction. actor_kind is read in that transaction (the auth plugin does not carry users.kind).

import type { Tx } from '../engine/context.js';
import type { Viewer } from '../services/types.js';

export async function auditRaw(
  tx: Tx,
  viewer: Viewer,
  action: string,
  subject: { type: string; id: string | null },
  details: Record<string, unknown> = {},
): Promise<void> {
  const kind = (await tx`SELECT kind FROM users WHERE id = ${viewer.id}`)[0]?.kind ?? 'human';
  await tx`
    INSERT INTO bastion_audit_log (organization_id, actor_id, actor_kind, impersonator_id, action, subject_type, subject_id, details)
    VALUES (${viewer.org_id}, ${viewer.id}, ${kind as string}, ${viewer.impersonator_id}, ${action}, ${subject.type}, ${subject.id},
            ${tx.json({ auth_method: viewer.auth_method, ...details } as never)})`;
}

/** The caller's users.kind, read in the transaction: agents and services trigger `agent` runs. */
export async function viewerKind(tx: Tx, viewer: Viewer): Promise<string> {
  return String((await tx`SELECT kind FROM users WHERE id = ${viewer.id}`)[0]?.kind ?? 'human');
}
