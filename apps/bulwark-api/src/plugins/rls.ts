import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';

/**
 * Row-level security plugin for bulwark-api (mirrors apps/basis-api/src/plugins/rls.ts).
 *
 * Runs as a preHandler on every authenticated request and sets the
 * `app.current_org_id` GUC from `request.user.active_org_id` so the Postgres RLS
 * policies that gate the bulwark_* tables (migrations 0234/0235) see the caller's
 * org. Without this the policies are inert for bulwark-api: in soft mode the app
 * role has BYPASSRLS so nothing changes, but the moment the platform flips
 * BBB_RLS_ENFORCE=1 (a coordinated platform posture, spec 2.5 point 11) every
 * bulwark query would return zero rows. Setting the GUC here keeps bulwark-api
 * correct under enforce mode and makes the policies actually bind. Bulwark does
 * NOT flip the DB role itself (that is apps/api/src/boot/rls-boot.ts).
 *
 * `set_config(..., true)` is transaction/session-local. Unauthenticated routes
 * (health/readyz) never reach the preHandler, and the hook is a no-op when
 * `request.user` is absent.
 */
const rlsPlugin = fp(async (fastify: FastifyInstance) => {
  const enforce = process.env.BBB_RLS_ENFORCE === '1';

  fastify.addHook('preHandler', async (request) => {
    const user = request.user;
    if (!user?.active_org_id) return;
    try {
      await db.execute(sql`SELECT set_config('app.current_org_id', ${user.active_org_id}, true)`);
    } catch (err) {
      if (enforce) throw err;
      request.log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'rls plugin: set_config failed (soft mode, continuing)',
      );
    }
  });

  fastify.log.info(
    { enforce },
    enforce
      ? 'bulwark-api rls plugin registered (NOBYPASSRLS enforce mode)'
      : 'bulwark-api rls plugin registered (advisory mode, BYPASSRLS)',
  );
});

export default rlsPlugin;
