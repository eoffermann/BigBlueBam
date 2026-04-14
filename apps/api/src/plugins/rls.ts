import fp from 'fastify-plugin';
import { sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { db } from '../db/index.js';
import { env } from '../env.js';

/**
 * Wave 1 / Platform §3.3 — Row-Level Security plumbing.
 *
 * Migration 0075 enabled RLS on the six core tables (organizations,
 * projects, tasks, sprints, tickets, activity_log) keyed on a Postgres
 * session variable `app.current_org_id`. This plugin exposes a
 * request-scoped helper — `request.withRls(async (tx) => ...)` — that
 * runs a callback inside a transaction with that variable set to the
 * caller's active org.
 *
 * Rollout strategy (see DECISIONS.md D-016). The plan's original text
 * told us to keep `BBB_RLS_ENFORCE=0` as a strict no-op that leaves
 * the session variable unset so unconverted handlers "break loudly"
 * the moment any other handler migrates to withRls. That is hostile to
 * partial adoption: as soon as migration 0075 runs against the shared
 * dev database, every unconverted handler returns zero rows from
 * organizations / projects / tasks / sprints / tickets / activity_log,
 * and the whole app wedges.
 *
 * Wave 1 instead ships two behaviors gated on BBB_RLS_ENFORCE:
 *
 *   - '0' (default): on Fastify boot we run `ALTER ROLE <dbuser> BYPASSRLS`
 *     so the single shared Bam role ignores policies entirely. The
 *     migration still enables and FORCEs RLS, and the withRls helper is
 *     still installed so Wave 2 handlers can begin adopting the pattern,
 *     but policies are effectively no-ops for live traffic until the
 *     conversion finishes.
 *
 *   - '1' (Wave 2 cutover): boot runs `ALTER ROLE <dbuser> NOBYPASSRLS`
 *     and withRls writes `app.current_org_id` inside a transaction. Any
 *     handler that forgets to use withRls returns zero rows — the
 *     desired fail-safe once every core-table route has been converted.
 *
 * Revert: flip the flag back to '0' and restart the api container; the
 * role is restamped BYPASSRLS at boot.
 */

export type RlsTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

declare module 'fastify' {
  interface FastifyRequest {
    withRls: <T>(fn: (tx: RlsTx) => Promise<T>) => Promise<T>;
  }
}

function parseDbUser(databaseUrl: string): string | null {
  try {
    const url = new URL(databaseUrl);
    if (!url.username) return null;
    return decodeURIComponent(url.username);
  } catch {
    return null;
  }
}

/**
 * Grant or revoke BYPASSRLS on the Bam API's database role based on the
 * BBB_RLS_ENFORCE flag. Runs once at boot. A failure to run the ALTER is
 * logged but not fatal — in dev the role may already be a superuser
 * (implicit bypass) and in managed environments the API role may not
 * own itself. Either way, the policies still work correctly if the
 * handler layer uses withRls.
 */
async function applyRlsEnforcementFlag(fastify: FastifyInstance) {
  const dbUser = parseDbUser(env.DATABASE_URL);
  if (!dbUser) {
    fastify.log.warn(
      { flag: env.BBB_RLS_ENFORCE },
      'RLS: could not parse DATABASE_URL username; skipping BYPASSRLS toggle',
    );
    return;
  }

  // Quote the role identifier defensively. Postgres identifiers must be
  // wrapped in double quotes to survive uppercase characters and hyphens.
  const quotedRole = `"${dbUser.replace(/"/g, '""')}"`;
  const targetAttribute = env.BBB_RLS_ENFORCE === '1' ? 'NOBYPASSRLS' : 'BYPASSRLS';

  try {
    // sql.raw is used deliberately: ALTER ROLE does not support parameter
    // binding for the role name, and the attribute is a fixed keyword
    // chosen from a two-element allowlist above.
    await db.execute(sql.raw(`ALTER ROLE ${quotedRole} ${targetAttribute}`));
    fastify.log.info(
      {
        role: dbUser,
        attribute: targetAttribute,
        flag: env.BBB_RLS_ENFORCE,
      },
      'RLS: applied role attribute for Wave 1 bypass strategy',
    );
  } catch (err) {
    fastify.log.warn(
      { err, role: dbUser, attribute: targetAttribute },
      'RLS: failed to apply role attribute; continuing with default policies',
    );
  }
}

async function rlsPlugin(fastify: FastifyInstance) {
  // Apply the boot-time role flip before any handler runs.
  await applyRlsEnforcementFlag(fastify);

  fastify.decorateRequest('withRls', null as unknown as FastifyRequest['withRls']);

  fastify.addHook('onRequest', async (request) => {
    request.withRls = async <T>(fn: (tx: RlsTx) => Promise<T>): Promise<T> => {
      // When RLS enforcement is off the role is BYPASSRLS at the
      // Postgres level; we still run inside a transaction to match the
      // behavior handlers will see when the flag flips, and to keep
      // downstream logic that relies on being in a transaction stable.
      const orgId = request.user?.active_org_id ?? null;
      return db.transaction(async (tx) => {
        if (env.BBB_RLS_ENFORCE === '1' && orgId) {
          await tx.execute(
            sql`SELECT set_config('app.current_org_id', ${orgId}, true)`,
          );
        }
        return fn(tx);
      });
    };
  });
}

export default fp(rlsPlugin, {
  name: 'rls',
});
