import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import postgres from 'postgres';
import { orgTx } from '../../src/engine/context.js';
import { appendLedger } from '../../src/engine/ledger.js';
import { ledgerVerify } from '../../src/engine/sweeps.js';
import { beginLedgerBatch } from '../../src/services/ledger-batch.js';
import { clock, DATABASE_URL, makeDeps, seedOrg, wipeOrg } from './engine-harness.js';

/**
 * Review batch 17, ledger-verify (live database):
 *   #297 the evidence.integrity_failed marker is keyed on the break as observed, so a row that was
 *        tampered, repaired, then tampered again alerts again (it was silenced forever).
 */

if (!DATABASE_URL) console.warn('[bastion-api/b17-ledger-verify] SKIPPING: DATABASE_URL is not set. Point it at a migrated database.');

describe.skipIf(!DATABASE_URL)('batch 17: ledger-verify chain-break alerts (live database)', () => {
  let sql: postgres.Sql;
  const orgs: string[] = [];

  beforeAll(() => {
    sql = postgres(DATABASE_URL!, { max: 8, onnotice: () => {} });
  });

  afterAll(async () => {
    if (!sql) return;
    for (const org of orgs) {
      await sql`DELETE FROM bastion_notice_markers WHERE organization_id = ${org}`;
      await wipeOrg(sql, org);
    }
    await sql.end();
  });

  /** Rewrite one ledger row's content hash behind the immutability trigger, as a DB-level tamper would. */
  async function setContent(org: string, seq: number, content: string) {
    await sql.begin(async (raw) => {
      const tx = raw as unknown as postgres.Sql;
      await tx`SET LOCAL session_replication_role = replica`;
      await tx`UPDATE bastion_ledger_entries SET content_sha256 = ${content} WHERE organization_id = ${org} AND seq = ${seq}`;
    });
  }

  async function alerts(org: string): Promise<number> {
    const r = await sql`SELECT 1 FROM bastion_outbox WHERE organization_id = ${org} AND kind = 'bolt_event' AND payload->>'event_type' = 'evidence.integrity_failed'`;
    return r.length;
  }

  it('tamper, alert; repair, quiet; tamper again with another value, alert again (#297)', async () => {
    const s = await seedOrg(sql, 'b17-verify', 0, 0);
    orgs.push(s.org);
    const engine = makeDeps(sql, { clock: clock() });
    const highest = await beginLedgerBatch(engine, s.org);
    await orgTx(sql, s.org, (tx) =>
      appendLedger(
        tx,
        s.org,
        [1, 2, 3].map((i) => ({ kind: 'attestation' as const, id: randomUUID(), content_sha256: String(i).repeat(64), personal_data_hmac: null, pd_hmac_key_id: null })),
        { highest, now: engine.now() },
      ),
    );
    const seq = Number((await sql`SELECT seq FROM bastion_ledger_entries WHERE organization_id = ${s.org} ORDER BY seq OFFSET 1 LIMIT 1`)[0]!.seq);
    const original = String((await sql`SELECT content_sha256 FROM bastion_ledger_entries WHERE organization_id = ${s.org} AND seq = ${seq}`)[0]!.content_sha256);
    const verify = () => ledgerVerify(engine, engine.sealKeys, { organization_id: s.org });

    expect((await verify()).orgs[0]).toMatchObject({ problems: 0 });
    expect(await alerts(s.org)).toBe(0);

    await setContent(s.org, seq, 'a'.repeat(64));
    expect((await verify()).orgs[0]).toMatchObject({ problems: 1 });
    expect(await alerts(s.org)).toBe(1);
    // The same unrepaired break on the next pass: still one alert.
    await verify();
    expect(await alerts(s.org)).toBe(1);

    // Repaired: clean, nothing new.
    await setContent(s.org, seq, original);
    expect((await verify()).orgs[0]).toMatchObject({ problems: 0 });
    expect(await alerts(s.org)).toBe(1);

    // Tampered again with a different value at the same seq: a new alert.
    await setContent(s.org, seq, 'b'.repeat(64));
    expect((await verify()).orgs[0]).toMatchObject({ problems: 1 });
    expect(await alerts(s.org)).toBe(2);

    // Repaired, then the FIRST value again: the clean pass forgot the old break, so it alerts too.
    await setContent(s.org, seq, original);
    await verify();
    await setContent(s.org, seq, 'a'.repeat(64));
    await verify();
    expect(await alerts(s.org)).toBe(3);
  });
});
