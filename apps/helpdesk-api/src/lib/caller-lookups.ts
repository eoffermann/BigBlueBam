// Raw reads against the shared Bam tables that helpdesk-api's two Bam-credential guards
// (lib/agent-auth.ts and lib/admin-auth.ts) both need. One copy, so the guards cannot drift
// on what a caller's home org or membership is (#351). helpdesk-api has no Drizzle schema for
// sessions / organization_memberships, hence raw SQL.

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

/** Rows from db.execute, whichever shape the driver returns (an array or `{ rows }`). */
export function rowsOf(raw: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] } | null)?.rows ?? [])) as Array<
    Record<string, unknown>
  >;
}

/** users.org_id: the org a caller acts in when nothing else fixes one. */
export async function homeOrg(userId: string): Promise<string | null> {
  const row = rowsOf(await db.execute(sql`SELECT org_id FROM users WHERE id = ${userId} LIMIT 1`))[0];
  return (row?.org_id as string | null | undefined) ?? null;
}

/** The user exists, is active, and belongs to orgId (or is a SuperUser, who may act in any org). */
export async function isActiveMemberOrSuperuser(userId: string, orgId: string): Promise<boolean> {
  const result = await db.execute(
    sql`SELECT u.id
        FROM users u
        WHERE u.id = ${userId}
          AND u.is_active = true
          AND (
            u.is_superuser = true
            OR EXISTS (
              SELECT 1 FROM organization_memberships m
              WHERE m.user_id = u.id AND m.org_id = ${orgId}
            )
          )
        LIMIT 1`,
  );
  return rowsOf(result).length > 0;
}
