/**
 * Boot-time visibility check for bastion-api's RLS backstop. Ported from bursar-api.
 *
 * Every service currently connects as a Postgres SUPERUSER, which bypasses RLS
 * unconditionally, so the bastion_* policies (M2) are present but not evaluated and the
 * app-level organization_id predicate is the only tenant boundary. Refusing to boot would make
 * bastion-api unstartable everywhere without fixing anything, so this reads pg_roles and logs
 * the real posture instead. Never throws, never exits.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

export type RlsBackstopStatus = 'bound' | 'absent' | 'unknown';

interface BootLogger {
  fatal: (obj: object, msg: string) => void;
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

export async function readRlsBackstopStatus(): Promise<{
  status: RlsBackstopStatus;
  role: string | null;
  reason?: 'rolsuper' | 'rolbypassrls';
  error?: string;
}> {
  try {
    const result = (await db.execute(
      sql`SELECT current_user::text AS role, rolsuper, rolbypassrls
          FROM pg_roles WHERE rolname = current_user`,
    )) as unknown;
    const rows = (
      Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    ) as Array<{ role?: string; rolsuper?: boolean; rolbypassrls?: boolean }>;
    const row = rows[0];
    if (!row) return { status: 'unknown', role: null, error: 'current_user not found in pg_roles' };
    const role = row.role ?? null;
    if (row.rolsuper === true) return { status: 'absent', role, reason: 'rolsuper' };
    if (row.rolbypassrls === true) return { status: 'absent', role, reason: 'rolbypassrls' };
    return { status: 'bound', role };
  } catch (err) {
    return {
      status: 'unknown',
      role: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function assertRlsBound(logger: BootLogger): Promise<RlsBackstopStatus> {
  const { status, role, reason, error } = await readRlsBackstopStatus();

  if (status === 'absent') {
    logger.fatal(
      {
        rls_backstop: 'absent',
        role,
        rls_bypass_reason: reason,
        bbb_rls_enforce: process.env.BBB_RLS_ENFORCE ?? null,
      },
      [
        'bastion-api RLS BACKSTOP IS ABSENT: the connecting role bypasses row-level security',
        `(cause: ${reason === 'rolsuper' ? 'it is a Postgres SUPERUSER' : 'it has BYPASSRLS'}).`,
        'The organization_id predicate in each query is the only tenant boundary. This is the',
        'platform default posture, not a bastion-api misconfiguration. Bastion is starting anyway.',
      ].join(' '),
    );
    return status;
  }

  if (status === 'unknown') {
    logger.warn(
      { rls_backstop: 'unknown', error },
      'bastion-api could not determine its RLS posture from pg_roles. Assume the backstop is absent.',
    );
    return status;
  }

  logger.info(
    { rls_backstop: 'bound', role },
    'bastion-api RLS backstop is bound: the database role is NOBYPASSRLS, so the bastion_* policies evaluate.',
  );
  return status;
}
