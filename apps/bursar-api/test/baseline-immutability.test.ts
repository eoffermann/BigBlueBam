import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

/**
 * Four-path immutability of bursar_baseline_items (spec 6.1, 7.1, M7).
 *
 * The frozen baseline is the fixed point every M8 detector measures reality against, so once
 * an award writes it, it must be UNMUTABLE by any path. Migration 0249 installs four defenses;
 * this suite VERIFIES them (it does not re-create them):
 *
 *   i.   BEFORE UPDATE, WHEN scoped to CONTENT columns  -> a content edit is rejected, but a
 *        write to a non-content column (an additive-migration backfill) is NOT aborted.
 *   ii.  BEFORE DELETE                                   -> a row delete is rejected.
 *   iii. award_id ON DELETE RESTRICT                     -> deleting the parent award is blocked
 *        (a cascade would NOT fire the row-level delete trigger, so RESTRICT is what protects it).
 *   iv.  BEFORE TRUNCATE, statement-level                -> a TRUNCATE is rejected.
 *
 * DB-backed. It SKIPS without DATABASE_URL (like the M1-M5 rls tests) and otherwise runs
 * regardless of the RLS posture: the immutability triggers fire for superusers too. Every test
 * runs inside a transaction that rolls back (the fixtures never persist, and the immutable rows
 * are never left behind - which they could not be deleted anyway, which is the whole point).
 */

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    '[bursar-api/baseline-immutability] SKIPPING: DATABASE_URL is not set. Point it at a ' +
      'migrated database (compose stack or CI service container) to exercise the four immutability paths.',
  );
}

const ORG = '00000000-0000-0000-0000-0000ba5e0001';
const USER = '00000000-0000-0000-0000-0000ba5e0002';
const REQUEST = '00000000-0000-0000-0000-0000ba5e0003';
const NODE = '00000000-0000-0000-0000-0000ba5e0004';
const AWARD = '00000000-0000-0000-0000-0000ba5e0005';
const ITEM = '00000000-0000-0000-0000-0000ba5e0006';

/** Seed org -> user -> request -> scope node -> award -> one frozen baseline item. */
async function seed(tx: postgres.TransactionSql): Promise<void> {
  await tx`INSERT INTO organizations (id, name, slug)
           VALUES (${ORG}, 'Bursar Immutability', 'bursar-immutability')
           ON CONFLICT (id) DO NOTHING`;
  await tx`INSERT INTO users (id, org_id, email, display_name, password_hash,
                              is_active, is_superuser, email_verified, kind)
           VALUES (${USER}, ${ORG}, 'bursar-immutability@bigbluebam.internal', 'Immut', '!',
                   true, false, true, 'service')
           ON CONFLICT (id) DO NOTHING`;
  await tx`INSERT INTO bursar_requests (id, organization_id, title, created_by)
           VALUES (${REQUEST}, ${ORG}, 'Immutability RFQ', ${USER})
           ON CONFLICT (id) DO NOTHING`;
  await tx`INSERT INTO bursar_scope_nodes (id, organization_id, request_id, title, dedup_key)
           VALUES (${NODE}, ${ORG}, ${REQUEST}, 'Warranty', 'immut-warranty')
           ON CONFLICT (id) DO NOTHING`;
  await tx`INSERT INTO bursar_awards (id, organization_id, request_id, chain_root_id, awarded_by)
           VALUES (${AWARD}, ${ORG}, ${REQUEST}, ${AWARD}, ${USER})
           ON CONFLICT (id) DO NOTHING`;
  await tx`INSERT INTO bursar_baseline_items (id, organization_id, award_id, kind, title, coverage_verdict_at_award)
           VALUES (${ITEM}, ${ORG}, ${AWARD}, 'included', 'Warranty', 'partial')
           ON CONFLICT (id) DO NOTHING`;
}

/** Run a block inside a transaction that always rolls back; return the pg error it raised, or null. */
async function expectRejected(
  sql: postgres.Sql,
  act: (tx: postgres.TransactionSql) => Promise<void>,
): Promise<{ message: string; code?: string } | null> {
  try {
    await sql.begin(async (tx) => {
      await seed(tx);
      await act(tx);
    });
    return null;
  } catch (err) {
    return { message: err instanceof Error ? err.message : String(err), code: (err as { code?: string }).code };
  }
}

describe.skipIf(!DATABASE_URL)('bursar_baseline_items four-path immutability', () => {
  let sql: postgres.Sql;

  beforeAll(() => {
    sql = postgres(DATABASE_URL as string, { max: 2, onnotice: () => {} });
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it('path i: rejects a BEFORE UPDATE on a content column', async () => {
    const err = await expectRejected(sql, async (tx) => {
      await tx`UPDATE bursar_baseline_items SET title = 'tampered' WHERE id = ${ITEM}`;
    });
    expect(err).not.toBeNull();
    expect(`${err!.message} ${err!.code ?? ''}`).toMatch(/BURSAR_BASELINE_IMMUTABLE|restrict_violation/);
  });

  it('path i (precision): a write to a NON-content column is allowed (additive migrations survive)', async () => {
    // created_at is deliberately absent from the trigger WHEN clause, so touching it does NOT
    // fire the immutability guard. This proves path i is content-scoped rather than a blanket
    // BEFORE UPDATE that would abort any future additive-column backfill.
    let after: string | null = null;
    let sentinel: string | null = null;
    try {
      await sql.begin(async (tx) => {
        await seed(tx);
        await tx`UPDATE bursar_baseline_items SET created_at = now() WHERE id = ${ITEM}`;
        const rows = await tx<Array<{ title: string }>>`SELECT title FROM bursar_baseline_items WHERE id = ${ITEM}`;
        after = rows[0]?.title ?? null;
        throw new Error('ROLLBACK_SENTINEL');
      });
    } catch (err) {
      sentinel = err instanceof Error ? err.message : String(err);
    }
    // The non-content update succeeded (we reached the SELECT and read the untouched title),
    // and only our own sentinel rolled the transaction back.
    expect(sentinel).toBe('ROLLBACK_SENTINEL');
    expect(after).toBe('Warranty');
  });

  it('path ii: rejects a BEFORE DELETE of a baseline row', async () => {
    const err = await expectRejected(sql, async (tx) => {
      await tx`DELETE FROM bursar_baseline_items WHERE id = ${ITEM}`;
    });
    expect(err).not.toBeNull();
    expect(`${err!.message} ${err!.code ?? ''}`).toMatch(/BURSAR_BASELINE_IMMUTABLE|restrict_violation/);
  });

  it('path iii: deleting the parent award is RESTRICTed (a cascade would not fire the row trigger)', async () => {
    const err = await expectRejected(sql, async (tx) => {
      await tx`DELETE FROM bursar_awards WHERE id = ${AWARD}`;
    });
    expect(err).not.toBeNull();
    // Foreign-key RESTRICT is a 23503, and it names the baseline items FK.
    expect(`${err!.message} ${err!.code ?? ''}`).toMatch(/23503|foreign key|bursar_baseline_items|restrict/i);
  });

  it('path iv: the BEFORE TRUNCATE statement trigger rejects a TRUNCATE (reached via CASCADE)', async () => {
    // A BARE `TRUNCATE bursar_baseline_items` is refused earlier, by Postgres itself, because the
    // table is referenced by inbound FKs (bursar_baseline_item_nodes, bursar_spend_events) - a
    // 0A000 that never reaches the trigger. To exercise the statement TRIGGER specifically we use
    // CASCADE, which fires the BEFORE TRUNCATE trigger on bursar_baseline_items and raises. Both
    // outcomes mean the table cannot be truncated; this asserts the trigger path.
    const err = await expectRejected(sql, async (tx) => {
      await tx`TRUNCATE bursar_baseline_items CASCADE`;
    });
    expect(err).not.toBeNull();
    expect(`${err!.message} ${err!.code ?? ''}`).toMatch(/BURSAR_BASELINE_IMMUTABLE|restrict_violation/);
  });

  it('path iv (defense in depth): a bare TRUNCATE is independently blocked by inbound FK references', async () => {
    const err = await expectRejected(sql, async (tx) => {
      await tx`TRUNCATE bursar_baseline_items`;
    });
    expect(err).not.toBeNull();
    // Either Postgres refuses (0A000, FK-referenced) or the trigger fires - both keep it undeletable.
    expect(`${err!.message} ${err!.code ?? ''}`).toMatch(/0A000|cannot truncate|BURSAR_BASELINE_IMMUTABLE|restrict_violation/);
  });
});
