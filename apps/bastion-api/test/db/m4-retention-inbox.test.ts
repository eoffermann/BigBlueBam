import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { retention, RETENTION_DEAD_OUTBOX_DAYS, RETENTION_UNCONSUMED_INBOX_DAYS } from '../../src/engine/sweeps.js';
import { clock, DATABASE_URL, makeDeps, seedOrg, wipeOrg } from './engine-harness.js';

/**
 * Issue #206 against a real migrated database:
 *
 *   retention prunes unconsumed (pending) inbox rows and failed/dead inbox rows past their window,
 *   and dead outbox rows past the longer re-drive/audit window, keeping everything younger and
 *   anything in flight (processing, pending outbox);
 *   POST /v1/internal/events stores only what Bastion consumes: a bastion.* proposal decision for
 *   an org with Bastion set up. Another app's proposal decision, or any event for an org without
 *   Bastion, is acknowledged (202) and dropped.
 *
 * SKIPS LOUDLY without DATABASE_URL.
 */

if (!DATABASE_URL) {
  console.warn('[bastion-api/m4-retention-inbox] SKIPPING: DATABASE_URL is not set. Point it at a migrated database.');
}

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

const DAY = 86_400_000;
const SECRET = 'i'.repeat(40);

describe.skipIf(!DATABASE_URL)('M4 retention and inbox gating (live database, #206)', () => {
  let sql: postgres.Sql;
  let app: FastifyInstance;
  const orgs: string[] = [];

  beforeAll(async () => {
    const hex = 'a'.repeat(64);
    Object.assign(process.env, {
      SESSION_SECRET: process.env.SESSION_SECRET ?? 's'.repeat(40),
      INTERNAL_SERVICE_SECRET: SECRET,
      BASTION_SEAL_SIGNING_KEY: process.env.BASTION_SEAL_SIGNING_KEY ?? '5'.repeat(64),
      BASTION_PD_HMAC_KEY: process.env.BASTION_PD_HMAC_KEY ?? hex,
      BASTION_ROOM_IP_SALT: process.env.BASTION_ROOM_IP_SALT ?? hex,
      BASTION_FEED_KEY_PEPPER: process.env.BASTION_FEED_KEY_PEPPER ?? hex,
    });
    sql = postgres(DATABASE_URL!, { max: 4, onnotice: () => {} });
    const { default: internalRoutes } = await import('../../src/routes/internal.routes.js');
    app = Fastify();
    app.decorate('redis', { get: async () => null, set: async () => 'OK' } as never);
    await app.register(internalRoutes, { prefix: '/v1' });
    await app.ready();
  });

  afterAll(async () => {
    if (app) await app.close();
    if (!sql) return;
    for (const org of orgs) await wipeOrg(sql, org);
    await sql.end();
    const db = await import('../../src/db/index.js');
    for (const c of db.allConnections()) await c.end();
  });

  it('retention prunes unconsumed and terminal inbox rows and old dead outbox rows; keeps young and in-flight rows', async () => {
    const s = await seedOrg(sql, 'retention');
    orgs.push(s.org);
    const c = clock();
    const deps = makeDeps(sql, { clock: c });
    const ago = (days: number) => new Date(Date.now() - days * DAY);
    const inbox = async (key: string, status: string, ageDays: number) =>
      sql`INSERT INTO bastion_ingest_events (organization_id, source, event_type, source_idempotency_key, status, created_at, updated_at)
          VALUES (${s.org}, 'platform', 'proposal.decided', ${key}, ${status}, ${ago(ageDays)}, ${ago(ageDays)})`;
    const outbox = async (key: string, status: string, ageDays: number) =>
      sql`INSERT INTO bastion_outbox (organization_id, kind, ordering_key, idempotency_key, status, created_at, delivered_at)
          VALUES (${s.org}, 'bolt_event', ${`org:${s.org}`}, ${key}, ${status}, ${ago(ageDays)},
                  ${status === 'delivered' ? ago(ageDays) : null})`;
    await inbox('pending-old', 'pending', RETENTION_UNCONSUMED_INBOX_DAYS + 1);
    await inbox('pending-young', 'pending', 1);
    await inbox('failed-old', 'failed', 31);
    await inbox('dead-old', 'dead', 31);
    await inbox('processing-old', 'processing', 60);
    await outbox('dead-old', 'dead', RETENTION_DEAD_OUTBOX_DAYS + 1);
    await outbox('dead-young', 'dead', 30);
    await outbox('delivered-old', 'delivered', 31);
    await outbox('pending-old', 'pending', 200);

    const res = await retention(deps, { organization_id: s.org });
    expect(res).toMatchObject({ outbox_pruned: 1, outbox_dead_pruned: 1, ingest_pruned: 2, ingest_unconsumed_pruned: 1 });
    const keptInbox = (await sql`SELECT source_idempotency_key AS k FROM bastion_ingest_events WHERE organization_id = ${s.org} ORDER BY 1`).map((r) => r.k);
    expect(keptInbox).toEqual(['pending-young', 'processing-old']);
    const keptOutbox = (await sql`SELECT idempotency_key AS k FROM bastion_outbox WHERE organization_id = ${s.org} ORDER BY 1`).map((r) => r.k);
    expect(keptOutbox).toEqual(['dead-young', 'pending-old']);
  });

  it('the inbox stores a bastion.* proposal decision for a set-up org, and drops other apps\' decisions and orgs without Bastion', async () => {
    const s = await seedOrg(sql, 'inbox');
    orgs.push(s.org);
    const post = (org: string, action: string, id: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/internal/events',
        headers: { 'x-internal-secret': SECRET },
        payload: { organization_id: org, source: 'platform', event: 'proposal.decided', event_id: id, payload: { proposal: { id, proposed_action: action } } },
      });

    const mine = await post(s.org, 'bastion.fix.confirm_check', 'e1');
    expect(mine.statusCode).toBe(202);
    expect(mine.json().data).toMatchObject({ accepted: true, duplicate: false });

    const other = await post(s.org, 'bursar.draft.send', 'e2');
    expect(other.statusCode).toBe(202);
    expect(other.json().data).toEqual({ accepted: false, ignored: 'not_consumed' });

    // An org that exists but never set Bastion up.
    const [o] = await sql`INSERT INTO organizations (name, slug) VALUES ('Bastion #206 no-setup', ${`bastion-206-nosetup-${Date.now()}`}) RETURNING id`;
    orgs.push(o!.id as string);
    const noSetup = await post(o!.id as string, 'bastion.fix.confirm_check', 'e3');
    expect(noSetup.statusCode).toBe(202);
    expect(noSetup.json().data).toEqual({ accepted: false, ignored: 'not_set_up' });

    const rows = await sql`SELECT organization_id, source_idempotency_key AS k FROM bastion_ingest_events
                            WHERE organization_id IN ${sql([s.org, o!.id as string])}`;
    expect(rows.map((r) => r.k)).toEqual(['platform:proposal.decided:e1']);
  });
});
