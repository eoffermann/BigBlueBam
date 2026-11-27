/**
 * Issue #349: the fan-out's recipient write, against a real Postgres.
 *
 * The worker used to write its whole recipients snapshot back after a pass,
 * reverting answers (joined/declined/granted) that summon_respond and
 * grantAccessAndSummon wrote while the pass was notifying. The write is now
 * one statement that changes only the entries this pass decided, each only
 * while it still has the outcome the worker read.
 *
 * Uses a session-local TEMP bureau_summons table (it shadows any real one),
 * so it needs a reachable Postgres but no migrations. Skips when DATABASE_URL
 * is unset.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { randomUUID } from 'node:crypto';

import { buildRecipientTransitionUpdate } from '../src/jobs/bureau-summon-fanout.js';

const DATABASE_URL = process.env.DATABASE_URL;

describe.skipIf(!DATABASE_URL)('bureau summon fan-out recipient write (#349, real DB)', () => {
  let client: postgres.Sql;
  let db: ReturnType<typeof drizzle>;

  beforeAll(async () => {
    // One connection: the TEMP table lives on it.
    client = postgres(DATABASE_URL as string, { max: 1, onnotice: () => {} });
    db = drizzle(client);
    await client`CREATE TEMP TABLE bureau_summons (id uuid PRIMARY KEY, recipients jsonb NOT NULL)`;
  });

  afterAll(async () => {
    await client?.end();
  });

  async function seed(recipients: unknown[]): Promise<string> {
    const id = randomUUID();
    await client`INSERT INTO bureau_summons (id, recipients) VALUES (${id}, ${JSON.stringify(recipients)}::jsonb)`;
    return id;
  }

  async function read(id: string): Promise<Array<Record<string, unknown>>> {
    const rows = await client<{ recipients: Array<Record<string, unknown>> }[]>`SELECT recipients FROM bureau_summons WHERE id = ${id}`;
    return rows[0]!.recipients;
  }

  it('applies only guarded transitions and keeps concurrent answers', async () => {
    const id = await seed([
      { userId: 'u0', outcome: 'pending', name: 'Gilligan' },
      { userId: 'u1', outcome: 'pending' },
      { userId: 'u2', outcome: 'no_access', reason: 'degraded_timeout' },
      { userId: 'u3', outcome: 'pending', reason: 'degraded_http_error' },
    ]);

    // Concurrent writers land after the worker read the row.
    await client`UPDATE bureau_summons SET recipients = jsonb_set(recipients, '{0,outcome}', '"joined"') WHERE id = ${id}`;
    await client`UPDATE bureau_summons SET recipients = jsonb_set(recipients #- '{2,reason}', '{2,outcome}', '"granted"') WHERE id = ${id}`;

    await db.execute(
      buildRecipientTransitionUpdate(id, [
        // Stale: the worker read u0 pending and re-records it; u0 has since joined.
        { userId: 'u0', from: 'pending', outcome: 'pending', reason: 'degraded_timeout' },
        { userId: 'u1', from: 'pending', outcome: 'no_access', reason: 'not_a_member' },
        // Stale: the worker read u2 as a degraded no_access; the summoner has granted it.
        { userId: 'u2', from: 'no_access', outcome: 'pending', reason: null },
        { userId: 'u3', from: 'pending', outcome: 'pending', reason: null },
      ]),
    );

    expect(await read(id)).toEqual([
      { userId: 'u0', outcome: 'joined', name: 'Gilligan' },
      { userId: 'u1', outcome: 'no_access', reason: 'not_a_member' },
      { userId: 'u2', outcome: 'granted' },
      { userId: 'u3', outcome: 'pending', reason: null },
    ]);
  });

  it('leaves recipients without a transition and the array order untouched', async () => {
    const id = await seed([
      { userId: 'a', outcome: 'declined' },
      { userId: 'b', outcome: 'pending' },
      { userId: 'c', outcome: 'pending' },
    ]);
    await db.execute(buildRecipientTransitionUpdate(id, [{ userId: 'c', from: 'pending', outcome: 'no_access', reason: 'access_check_unavailable' }]));
    expect(await read(id)).toEqual([
      { userId: 'a', outcome: 'declined' },
      { userId: 'b', outcome: 'pending' },
      { userId: 'c', outcome: 'no_access', reason: 'access_check_unavailable' },
    ]);
  });
});
