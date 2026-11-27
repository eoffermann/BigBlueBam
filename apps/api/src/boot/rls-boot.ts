import { sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { db } from '../db/index.js';
import { env } from '../env.js';

/**
 * Boot-time RLS role gating (Wave 1.A, Platform G1).
 *
 * Runs once at process start, before Fastify begins accepting requests.
 * Reads `BBB_RLS_ENFORCE` and `DATABASE_ROLE` env vars and toggles the
 * configured database role between BYPASSRLS and NOBYPASSRLS:
 *
 *   - `BBB_RLS_ENFORCE=1` / `true` / `yes` / `on` -> NOBYPASSRLS (policies bind on every query).
 *   - unset / `0` / `false` / `no` / `off` -> BYPASSRLS (policies are advisory only).
 *   - any other value -> env.ts refuses to boot (#302).
 *
 * `DATABASE_ROLE` defaults to `bam_app`. The role must already exist in the
 * target database (typically created by 0000_init.sql or equivalent
 * bootstrap migration). If the role does not exist the boot hook logs a
 * warning and continues, so development databases without the dedicated
 * role do not crash the API.
 *
 * This is idempotent: running it twice with the same flag is a no-op.
 */
export async function rlsBoot(logger: Logger): Promise<void> {
  // #302: parsed once by env.ts through envBool, so `true`/`yes`/`on` enforce exactly like `1`
  // and an unrecognized value fails boot before this hook can pick BYPASSRLS.
  const enforce = env.BBB_RLS_ENFORCE === true;
  const role = process.env.DATABASE_ROLE || 'bam_app';

  try {
    const roleExists = (await db.execute(
      sql`SELECT 1 FROM pg_roles WHERE rolname = ${role} LIMIT 1`,
    )) as unknown as Array<{ '?column?'?: number }>;

    const rows = Array.isArray(roleExists) ? roleExists : (roleExists as { rows?: unknown[] }).rows ?? [];
    if (rows.length === 0) {
      logger.warn(
        { role, enforce },
        'rls-boot: database role not found, skipping role flip (development mode or missing bootstrap)',
      );
      return;
    }

    if (enforce) {
      // Use raw SQL because ALTER ROLE does not accept parameter bindings
      // for the role identifier. Role name is controlled by the operator
      // via env var; the default 'bam_app' and any override is a shell-
      // quoted identifier validated against pg_roles above.
      await db.execute(sql.raw(`ALTER ROLE "${role}" NOBYPASSRLS`));
      logger.info({ role }, 'rls-boot: role flipped to NOBYPASSRLS (enforce mode)');
    } else {
      await db.execute(sql.raw(`ALTER ROLE "${role}" BYPASSRLS`));
      logger.info({ role }, 'rls-boot: role flipped to BYPASSRLS (advisory mode)');
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), role, enforce },
      'rls-boot: failed to flip database role',
    );
    if (enforce) {
      // In enforce mode a failed flip is fatal because queries would
      // silently return empty results across the board.
      throw err;
    }
  }
}
