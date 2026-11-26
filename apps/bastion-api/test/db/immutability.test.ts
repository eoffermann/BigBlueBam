import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';

/**
 * Four-path immutability of Bastion's evidence (spec 3.4, migrations 0275-0278) and the
 * age-guarded auditor access log.
 *
 * Every case runs in a transaction that always rolls back, so fixtures never persist (and the
 * immutable rows could not be deleted anyway, which is the point). DB-backed: runs in CI's
 * db-drift job against the migrated service container; SKIPS LOUDLY without DATABASE_URL.
 * The triggers fire for superusers too, so the RLS posture does not matter here.
 */

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.warn(
    '[bastion-api/immutability] SKIPPING: DATABASE_URL is not set. Point it at a migrated ' +
      'database to exercise the immutability triggers and the access-log age guard.',
  );
}

const ORG = '00000000-0000-0000-0000-0000ba571001';
const USER = '00000000-0000-0000-0000-0000ba571002';
const CONTROL = '00000000-0000-0000-0000-0000ba571003';
const ASSERTION = '00000000-0000-0000-0000-0000ba571004';
const RUN = '00000000-0000-0000-0000-0000ba571005';
const SNAPSHOT = '00000000-0000-0000-0000-0000ba571006';
const ROOM = '00000000-0000-0000-0000-0000ba571007';
const SHA = 'a'.repeat(64);

async function seed(tx: postgres.TransactionSql): Promise<void> {
  await tx`INSERT INTO organizations (id, name, slug)
           VALUES (${ORG}, 'Bastion Immutability', 'bastion-immutability') ON CONFLICT (id) DO NOTHING`;
  await tx`INSERT INTO users (id, org_id, email, display_name, password_hash,
                              is_active, is_superuser, email_verified, kind)
           VALUES (${USER}, ${ORG}, 'bastion-immutability@bigbluebam.internal', 'Immut', '!',
                   true, false, true, 'service') ON CONFLICT (id) DO NOTHING`;
  await tx`INSERT INTO bastion_controls (id, organization_id, control_key, title)
           VALUES (${CONTROL}, ${ORG}, 'access.keys', 'Keys are rotated')`;
  await tx`INSERT INTO bastion_assertions (id, organization_id, control_id, kind, probe_key,
                                           probe_version, plain_statement, review_status)
           VALUES (${ASSERTION}, ${ORG}, ${CONTROL}, 'probe', 'keys.max_age', 1,
                   'No key older than 90 days', 'confirmed')`;
  await tx`INSERT INTO bastion_evaluation_runs (id, organization_id, trigger, scope, as_of, status)
           VALUES (${RUN}, ${ORG}, 'manual', 'all', now(), 'succeeded')`;
  await tx`INSERT INTO bastion_evidence_snapshots (id, organization_id, evaluation_run_id,
                                                   assertion_id, control_id, outcome, content_sha256)
           VALUES (${SNAPSHOT}, ${ORG}, ${RUN}, ${ASSERTION}, ${CONTROL}, 'pass', ${SHA})`;
  await tx`INSERT INTO bastion_evidence_objects (organization_id, content_sha256, object_key, size_bytes, holder_count)
           VALUES (${ORG}, ${SHA}, ${`evidence/${ORG}/${SHA}`}, 10, 1)`;
  await tx`INSERT INTO bastion_ledger_entries (organization_id, epoch, seq, entry_kind, entry_id,
                                               content_sha256, prev_entry_hash, entry_hash, recorded_at)
           VALUES (${ORG}, 1, 1, 'snapshot', ${SNAPSHOT}, ${SHA}, ${'0'.repeat(64)}, ${'b'.repeat(64)}, now())`;
  await tx`INSERT INTO bastion_auditor_rooms (id, organization_id, label, token_sha256, expires_at)
           VALUES (${ROOM}, ${ORG}, 'Coconut audit', ${'c'.repeat(64)}, now() + interval '30 days')`;
}

/** Runs `act` after seeding, then rolls back. Returns the pg error code/message, or null. */
async function attempt(
  sql: postgres.Sql,
  act: (tx: postgres.TransactionSql) => Promise<unknown>,
): Promise<string | null> {
  try {
    await sql.begin(async (tx) => {
      await seed(tx);
      await act(tx);
      throw new Error('ROLLBACK_SENTINEL');
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'ROLLBACK_SENTINEL') return null;
    return `${(err as { code?: string }).code ?? ''} ${message}`;
  }
  return null;
}

describe.skipIf(!DATABASE_URL)('Bastion evidence immutability', () => {
  let sql: postgres.Sql;

  beforeAll(() => {
    sql = postgres(DATABASE_URL as string, { max: 2, onnotice: () => {} });
  });

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
  });

  it('snapshots: UPDATE of any column is rejected', async () => {
    const err = await attempt(sql, (tx) => tx`UPDATE bastion_evidence_snapshots SET outcome = 'fail' WHERE id = ${SNAPSHOT}`);
    expect(err).toMatch(/BASTION_IMMUTABLE/);
  });

  it('snapshots: DELETE is rejected', async () => {
    const err = await attempt(sql, (tx) => tx`DELETE FROM bastion_evidence_snapshots WHERE id = ${SNAPSHOT}`);
    expect(err).toMatch(/BASTION_IMMUTABLE/);
  });

  it('snapshots: the parent assertion is RESTRICTed', async () => {
    const err = await attempt(sql, (tx) => tx`DELETE FROM bastion_assertions WHERE id = ${ASSERTION}`);
    expect(err).toMatch(/23503/);
  });

  it('snapshots: TRUNCATE is rejected', async () => {
    const err = await attempt(sql, (tx) => tx`TRUNCATE bastion_evidence_snapshots CASCADE`);
    expect(err).toMatch(/BASTION_IMMUTABLE/);
  });

  it('evidence objects: holder_count, mirrored_at and bytes_redacted_at change; content does not', async () => {
    const ok = await attempt(
      sql,
      (tx) => tx`UPDATE bastion_evidence_objects
                    SET holder_count = 2, mirrored_at = now(), bytes_redacted_at = now()
                  WHERE organization_id = ${ORG} AND content_sha256 = ${SHA}`,
    );
    expect(ok).toBeNull();
    const err = await attempt(
      sql,
      (tx) => tx`UPDATE bastion_evidence_objects SET object_key = 'moved'
                  WHERE organization_id = ${ORG} AND content_sha256 = ${SHA}`,
    );
    expect(err).toMatch(/BASTION_IMMUTABLE/);
    const del = await attempt(
      sql,
      (tx) => tx`DELETE FROM bastion_evidence_objects WHERE organization_id = ${ORG} AND content_sha256 = ${SHA}`,
    );
    expect(del).toMatch(/BASTION_IMMUTABLE/);
  });

  it('ledger entries: UPDATE and DELETE are rejected', async () => {
    const upd = await attempt(sql, (tx) => tx`UPDATE bastion_ledger_entries SET entry_hash = ${'d'.repeat(64)} WHERE organization_id = ${ORG} AND seq = 1`);
    expect(upd).toMatch(/BASTION_IMMUTABLE/);
    const del = await attempt(sql, (tx) => tx`DELETE FROM bastion_ledger_entries WHERE organization_id = ${ORG} AND seq = 1`);
    expect(del).toMatch(/BASTION_IMMUTABLE/);
  });

  it('assertions: content is frozen once confirmed, review_status may still move', async () => {
    const err = await attempt(sql, (tx) => tx`UPDATE bastion_assertions SET plain_statement = 'edited' WHERE id = ${ASSERTION}`);
    expect(err).toMatch(/BASTION_IMMUTABLE/);
    const ok = await attempt(sql, (tx) => tx`UPDATE bastion_assertions SET review_status = 'superseded' WHERE id = ${ASSERTION}`);
    expect(ok).toBeNull();
  });

  it('access log: a direct DELETE of a recent row fails whatever the session settings', async () => {
    const err = await attempt(sql, async (tx) => {
      await tx`SELECT set_config('app.bastion_purge', 'on', true)`;
      await tx`INSERT INTO bastion_auditor_access_log (organization_id, room_id, view_kind)
               VALUES (${ORG}, ${ROOM}, 'overview')`;
      await tx`DELETE FROM bastion_auditor_access_log WHERE organization_id = ${ORG}`;
    });
    expect(err).toMatch(/BASTION_ACCESS_LOG_RETAINED/);
  });

  it('access log: UPDATE is rejected; the purge removes only rows older than two years', async () => {
    const upd = await attempt(sql, async (tx) => {
      await tx`INSERT INTO bastion_auditor_access_log (organization_id, room_id, view_kind)
               VALUES (${ORG}, ${ROOM}, 'overview')`;
      await tx`UPDATE bastion_auditor_access_log SET view_kind = 'control' WHERE organization_id = ${ORG}`;
    });
    expect(upd).toMatch(/BASTION_IMMUTABLE/);

    let purged: number | null = null;
    let remaining: number | null = null;
    const err = await attempt(sql, async (tx) => {
      await tx`INSERT INTO bastion_auditor_access_log (organization_id, room_id, view_kind, accessed_at)
               VALUES (${ORG}, ${ROOM}, 'overview', now() - interval '3 years'),
                      (${ORG}, ${ROOM}, 'overview', now())`;
      const rows = await tx<Array<{ n: number }>>`SELECT bastion_purge_access_log(${ORG}::uuid) AS n`;
      purged = rows[0]?.n ?? null;
      const left = await tx<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM bastion_auditor_access_log WHERE organization_id = ${ORG}`;
      remaining = left[0]?.n ?? null;
    });
    expect(err).toBeNull();
    expect(purged).toBe(1);
    expect(remaining).toBe(1);
  });
});
