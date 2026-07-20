/**
 * Boot-time visibility check for bursar-api's RLS backstop (spec 6.3).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS.
 *
 * `plugins/rls.ts` binds `app.current_org_id` correctly, inside a real transaction, so every
 * `bursar_*` policy from migration 0251 evaluates against the caller's org. The mechanism is
 * right. What is currently absent is the SAFETY it appears to provide: a route that forgets
 * `runInOrgScope` does NOT read zero rows today, because the connecting role bypasses RLS.
 *
 * Two independent causes, in order of how hard they are to fix:
 *
 *   1. THE CONNECTING ROLE IS A POSTGRES SUPERUSER. Every service in the compose stack
 *      connects with the `POSTGRES_USER` credentials (`bigbluebam`), the only login role in
 *      the cluster, and it has `rolsuper = true`. A superuser bypasses RLS UNCONDITIONALLY;
 *      `ALTER ROLE ... NOBYPASSRLS` does not change that while `rolsuper` is set. Arming RLS
 *      requires a non-superuser application role in `DATABASE_URL`, not an env-var flip.
 *   2. `BBB_RLS_ENFORCE` is set in no compose file, no .env.example, and no deploy adapter in
 *      this repository, and `apps/api`'s `rls-boot.ts` targets a `bam_app` role that does not
 *      exist, so it issues no ALTER at all.
 *
 * So every bursar_* policy is present and unevaluated, and the app-level `organization_id`
 * predicate in each query is the ONLY tenant boundary. A missing or wrong `where` returns
 * another org's vendor prices, offers, and cost figures, and nothing logs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS DOES NOT REFUSE TO BOOT.
 *
 * The RLS bypass is the platform's present posture and it is not something bursar-api can
 * configure its way out of, so throwing would make bursar-api unstartable in every current
 * environment rather than fixing anything. The honest move is to make the real posture
 * VISIBLE at boot. This checks reality (`pg_roles`) rather than the env var, so it stays
 * correct even though the flag, the ALTER ROLE, and the credentials all live outside
 * bursar-api. When the platform moves to a non-superuser NOBYPASSRLS role this quietly starts
 * logging `rls_backstop: 'bound'`, and at that point this function is the natural place to
 * make the absent case fatal.
 */

import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

export type RlsBackstopStatus = 'bound' | 'absent' | 'unknown';

interface BootLogger {
  fatal: (obj: object, msg: string) => void;
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
}

/**
 * Reads `rolsuper` / `rolbypassrls` for the role the pool actually connected as. Returns
 * 'unknown' rather than throwing when the query fails, because a transient database hiccup at
 * boot must not take bursar-api down over a diagnostic.
 */
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
    // rolsuper is checked FIRST and reported distinctly: a superuser bypasses RLS
    // unconditionally, and ALTER ROLE ... NOBYPASSRLS will not change that.
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

/**
 * Logs bursar-api's effective RLS posture. Never throws, never exits. Call before `listen`.
 */
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
      'bursar-api RLS BACKSTOP IS ABSENT: the connecting role bypasses row-level security ' +
        `(cause: ${reason === 'rolsuper' ? 'it is a Postgres SUPERUSER' : 'it has BYPASSRLS'}), ` +
        'so every bursar_* policy is NOT evaluated. The app-level organization_id predicate ' +
        'in each query is currently the ONLY tenant boundary: a query that skips ' +
        'runInOrgScope, or a missing or wrong where clause, returns EVERY organization\'s ' +
        'rows rather than zero rows. This is the platform default posture, not a bursar-api ' +
        'misconfiguration. Arming it requires a non-superuser NOBYPASSRLS application role ' +
        'in DATABASE_URL; setting BBB_RLS_ENFORCE=1 alone is NOT sufficient while the role ' +
        'is a superuser. Bursar is starting anyway. See spec 6.3.',
    );
    return status;
  }

  if (status === 'unknown') {
    logger.warn(
      { rls_backstop: 'unknown', error },
      'bursar-api could not determine its RLS posture from pg_roles. Assume the backstop is ' +
        'absent and that the app-level organization_id predicate is the only tenant boundary.',
    );
    return status;
  }

  logger.info(
    { rls_backstop: 'bound', role },
    'bursar-api RLS backstop is bound: the database role is NOBYPASSRLS, so the bursar_* ' +
      'policies evaluate and a query that skips runInOrgScope reads zero rows.',
  );
  return status;
}
