import { sql } from 'drizzle-orm';
import type { DbTx } from '../db/index.js';
import { bastionAuditLog } from '../db/schema/index.js';
import type { Viewer } from '../services/types.js';

/** users.kind of the caller ('human' | 'agent' | 'service'), read in the caller's transaction. */
export async function actorKind(tx: DbTx, userId: string): Promise<string> {
  const rows = (await tx.execute(sql`SELECT kind FROM users WHERE id = ${userId} LIMIT 1`)) as unknown as Array<{
    kind: string | null;
  }>;
  return rows[0]?.kind ?? 'human';
}

/**
 * Append one bastion_audit_log row (append-only; UPDATE and TRUNCATE are rejected by 0274).
 * Every Bastion write records the actor and, while impersonating, the impersonator (spec 2.8).
 */
export async function audit(
  tx: DbTx,
  viewer: Viewer,
  action: string,
  subject: { type: string; id: string | null },
  details: Record<string, unknown> = {},
): Promise<void> {
  await tx.insert(bastionAuditLog).values({
    organization_id: viewer.org_id,
    actor_id: viewer.id,
    actor_kind: await actorKind(tx, viewer.id),
    impersonator_id: viewer.impersonator_id,
    action,
    subject_type: subject.type,
    subject_id: subject.id,
    details: { auth_method: viewer.auth_method, ...details },
  });
}
