/**
 * Boot-time visibility check for burn-api's RLS backstop (issue #90).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS.
 *
 * `plugins/rls.ts` binds `app.current_org_id` correctly, inside a real transaction, so
 * every `burn_*` policy from migrations 0239/0240/0241 evaluates against the caller's org.
 * The mechanism is right. What was wrong was the safety ARGUMENT built on top of it: that
 * a route which forgets `runInOrgScope` "reads zero rows rather than reading everyone's
 * rows."
 *
 * That holds only when the connecting role does NOT bypass RLS. Today it does, and the
 * reason is worse than the flag everyone reaches for first. Two independent causes, in
 * order of how hard they are to fix:
 *
 *   1. THE CONNECTING ROLE IS A POSTGRES SUPERUSER. Every service in the compose stack
 *      connects with the `POSTGRES_USER` credentials (`bigbluebam`), which is the only
 *      login role in the cluster and has `rolsuper = true`. A superuser bypasses RLS
 *      UNCONDITIONALLY. `ALTER ROLE ... NOBYPASSRLS` does not change that: `rolbypassrls`
 *      is irrelevant while `rolsuper` is set. Arming RLS therefore requires creating a
 *      non-superuser application role, granting it the table privileges, and repointing
 *      `DATABASE_URL` at it. Flipping an env var is not sufficient.
 *   2. `BBB_RLS_ENFORCE` is set in no compose file, no .env.example, no deploy adapter,
 *      and no service catalog entry in this repository. Note that `apps/api`'s
 *      `rls-boot.ts` is currently a no-op for a second reason as well: it targets
 *      `DATABASE_ROLE || 'bam_app'`, and no `bam_app` role exists, so it logs
 *      "database role not found, skipping role flip" and issues no ALTER at all.
 *
 * So the 14 burn_* policies are decorative, and the app-level `organization_id` predicate
 * in each query is the ONLY tenant boundary. A missing or wrong `where` returns another
 * firm's contract values and per-person cost rates, and nothing logs.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS DOES NOT REFUSE TO BOOT.
 *
 * `assert-permissions-enforce.ts` refuses to boot on a bad permission mode, and the same
 * reasoning would justify refusing here. The difference is reachability: the RLS bypass is
 * the platform's present posture and it is not something burn-api can configure its way
 * out of, so throwing would make burn-api unstartable in every current environment rather
 * than fixing anything. The honest move is to make the real posture VISIBLE at boot instead
 * of letting a reader infer it from a comment.
 *
 * This checks reality (`pg_roles`) rather than the env var, so it stays correct even
 * though the flag, the ALTER ROLE, and the credentials all live outside burn-api. When the
 * platform moves to a non-superuser NOBYPASSRLS role this quietly starts logging
 * `rls_backstop: 'bound'`, and at that point this function is the natural place to make
 * the absent case fatal.
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
 * Reads `rolbypassrls` for the role the pool actually connected as.
 *
 * Returns 'unknown' rather than throwing when the query fails, because a transient
 * database hiccup at boot must not take burn-api down over a diagnostic.
 */
export async function readRlsBackstopStatus(): Promise<{
  status: RlsBackstopStatus;
  role: string | null;
  /** Why the bypass is in effect, when it is. Superuser is the harder of the two to fix. */
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
 * Logs burn-api's effective RLS posture. Never throws, never exits. Call before `listen`.
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
      'burn-api RLS BACKSTOP IS ABSENT: the connecting role bypasses row-level security ' +
        `(cause: ${reason === 'rolsuper' ? 'it is a Postgres SUPERUSER' : 'it has BYPASSRLS'}), ` +
        'so all 14 burn_* policies are NOT evaluated. The app-level organization_id ' +
        'predicate in each query is currently the ONLY tenant boundary: a query that skips ' +
        'runInOrgScope, or a missing or wrong where clause, returns EVERY organization\'s ' +
        'rows rather than zero rows. This is the platform default posture, not a burn-api ' +
        'misconfiguration. Arming it requires a non-superuser NOBYPASSRLS application role ' +
        'in DATABASE_URL; setting BBB_RLS_ENFORCE=1 alone is NOT sufficient while the role ' +
        'is a superuser. Burn is starting anyway. See issue #90.',
    );
    return status;
  }

  if (status === 'unknown') {
    logger.warn(
      { rls_backstop: 'unknown', error },
      'burn-api could not determine its RLS posture from pg_roles. Assume the backstop is ' +
        'absent and that the app-level organization_id predicate is the only tenant boundary.',
    );
    return status;
  }

  logger.info(
    { rls_backstop: 'bound', role },
    'burn-api RLS backstop is bound: the database role is NOBYPASSRLS, so the burn_* ' +
      'policies evaluate and a query that skips runInOrgScope reads zero rows.',
  );
  return status;
}
