import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import postgres from 'postgres';
import type { Tx } from '../../src/engine/context.js';

/**
 * Four-path immutability of Bastion's evidence (spec 3.4, migrations 0275-0278), the frozen
 * status transitions of assertions, manual evidence and exceptions (0283, #184), the 0283 schema
 * contracts for the outbox (#189), exception-expiry drift (#188) and the partial-run resume
 * (#187), and the age-guarded auditor access log.
 *
 * Every case runs in a transaction that always rolls back, so fixtures never persist (and the
 * immutable rows could not be deleted anyway, which is the point). DB-backed: runs in CI's
 * Vitest job (.github/workflows/test.yml, not db-drift.yml) against the migrated service
 * container; SKIPS LOUDLY without DATABASE_URL.
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
const EVIDENCE = '00000000-0000-0000-0000-0000ba571008';
const EXCEPTION = '00000000-0000-0000-0000-0000ba571009';
const OTHER_USER = '00000000-0000-0000-0000-0000ba57100a';
const SHA = 'a'.repeat(64);

async function seed(tx: Tx): Promise<void> {
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
  await tx`INSERT INTO bastion_manual_evidence (id, organization_id, kind, title, uploaded_by,
                                                period_start, period_end, status)
           VALUES (${EVIDENCE}, ${ORG}, 'attestation_statement', 'Laptops have FileVault on', ${USER},
                   '2026-10-01', '2026-10-31', 'active')`;
  await tx`INSERT INTO bastion_exceptions (id, organization_id, control_id, scope, cited_entity_type,
                                           cited_entity_id, reason, status, proposed_by, decided_by,
                                           decided_at, expires_at)
           VALUES (${EXCEPTION}, ${ORG}, ${CONTROL}, 'entity', 'api_key', ${USER},
                   'Radio Relay key cannot rotate yet', 'active', ${USER}, ${OTHER_USER},
                   now(), now() + interval '30 days')`;
}

/** Runs `act` after seeding, then rolls back. Returns the pg error code/message, or null. */
async function attempt(
  sql: postgres.Sql,
  act: (tx: Tx) => Promise<unknown>,
): Promise<string | null> {
  try {
    await sql.begin(async (raw) => {
      const tx = raw as unknown as Tx;
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

  // #184: the status gate used to leave the status itself writable, so a frozen row could be
  // stepped back, edited and re-frozen with no trigger firing. Each case runs that exact
  // three-statement sequence; the first (regressing) statement must already be refused.
  it('assertions: confirmed -> proposed, edit, re-confirm is refused at the first step', async () => {
    const err = await attempt(sql, async (tx) => {
      await tx`UPDATE bastion_assertions SET review_status = 'proposed' WHERE id = ${ASSERTION}`;
      await tx`UPDATE bastion_assertions SET params = '{"window_days": 3650}'::jsonb WHERE id = ${ASSERTION}`;
      await tx`UPDATE bastion_assertions SET review_status = 'confirmed' WHERE id = ${ASSERTION}`;
    });
    expect(err).toMatch(/BASTION_IMMUTABLE/);
  });

  it('assertions: only forward moves; confirmed_by is frozen but may be cleared by its FK', async () => {
    const toRejected = await attempt(sql, (tx) => tx`UPDATE bastion_assertions SET review_status = 'rejected' WHERE id = ${ASSERTION}`);
    expect(toRejected).toMatch(/BASTION_IMMUTABLE/);
    const backFromSuperseded = await attempt(sql, async (tx) => {
      await tx`UPDATE bastion_assertions SET review_status = 'superseded' WHERE id = ${ASSERTION}`;
      await tx`UPDATE bastion_assertions SET review_status = 'confirmed' WHERE id = ${ASSERTION}`;
    });
    expect(backFromSuperseded).toMatch(/BASTION_IMMUTABLE/);
    const reattribute = await attempt(sql, (tx) => tx`UPDATE bastion_assertions SET confirmed_by = ${USER} WHERE id = ${ASSERTION}`);
    expect(reattribute).toMatch(/BASTION_IMMUTABLE/);
    const cleared = await attempt(sql, (tx) => tx`UPDATE bastion_assertions SET created_by = NULL WHERE id = ${ASSERTION}`);
    expect(cleared).toBeNull();
  });

  it('manual evidence: active -> pending_scan, swap the evidence, re-activate is refused at the first step', async () => {
    const err = await attempt(sql, async (tx) => {
      await tx`UPDATE bastion_manual_evidence SET status = 'pending_scan' WHERE id = ${EVIDENCE}`;
      await tx`UPDATE bastion_manual_evidence SET content_sha256 = ${'e'.repeat(64)}, period_end = '2026-12-31' WHERE id = ${EVIDENCE}`;
      await tx`UPDATE bastion_manual_evidence SET status = 'active' WHERE id = ${EVIDENCE}`;
    });
    expect(err).toMatch(/BASTION_IMMUTABLE/);
  });

  it('manual evidence: forward moves and operational columns pass; content and regressions do not', async () => {
    const content = await attempt(sql, (tx) => tx`UPDATE bastion_manual_evidence SET title = 'edited' WHERE id = ${EVIDENCE}`);
    expect(content).toMatch(/BASTION_IMMUTABLE/);
    const redacted = await attempt(sql, async (tx) => {
      await tx`UPDATE bastion_manual_evidence SET status = 'superseded' WHERE id = ${EVIDENCE}`;
      await tx`UPDATE bastion_manual_evidence
                  SET status = 'withdrawn', withdrawn_reason = 'redacted', withdrawn_by = ${USER},
                      withdrawn_at = now(), redacted_at = now()
                WHERE id = ${EVIDENCE}`;
    });
    expect(redacted).toBeNull();
    const unwithdraw = await attempt(sql, async (tx) => {
      await tx`UPDATE bastion_manual_evidence SET status = 'withdrawn' WHERE id = ${EVIDENCE}`;
      await tx`UPDATE bastion_manual_evidence SET status = 'active' WHERE id = ${EVIDENCE}`;
    });
    expect(unwithdraw).toMatch(/BASTION_IMMUTABLE/);
    const toBlocked = await attempt(sql, (tx) => tx`UPDATE bastion_manual_evidence SET status = 'blocked' WHERE id = ${EVIDENCE}`);
    expect(toBlocked).toMatch(/BASTION_IMMUTABLE/);
  });

  it('exceptions: active -> proposed, extend and re-decide, re-activate is refused at the first step', async () => {
    const err = await attempt(sql, async (tx) => {
      await tx`UPDATE bastion_exceptions SET status = 'proposed' WHERE id = ${EXCEPTION}`;
      await tx`UPDATE bastion_exceptions
                  SET expires_at = now() + interval '300 days', reason = 'widened', decided_by = ${USER}
                WHERE id = ${EXCEPTION}`;
      await tx`UPDATE bastion_exceptions SET status = 'active' WHERE id = ${EXCEPTION}`;
    });
    expect(err).toMatch(/BASTION_IMMUTABLE/);
  });

  it('exceptions: active -> expired passes once; expired never returns to active; content is frozen', async () => {
    const expire = await attempt(sql, (tx) => tx`UPDATE bastion_exceptions SET status = 'expired' WHERE id = ${EXCEPTION}`);
    expect(expire).toBeNull();
    const revive = await attempt(sql, async (tx) => {
      await tx`UPDATE bastion_exceptions SET status = 'expired' WHERE id = ${EXCEPTION}`;
      await tx`UPDATE bastion_exceptions SET status = 'active' WHERE id = ${EXCEPTION}`;
    });
    expect(revive).toMatch(/BASTION_IMMUTABLE/);
    const toRejected = await attempt(sql, (tx) => tx`UPDATE bastion_exceptions SET status = 'rejected' WHERE id = ${EXCEPTION}`);
    expect(toRejected).toMatch(/BASTION_IMMUTABLE/);
    const content = await attempt(sql, (tx) => tx`UPDATE bastion_exceptions SET expires_at = now() + interval '60 days' WHERE id = ${EXCEPTION}`);
    expect(content).toMatch(/BASTION_IMMUTABLE/);
  });

  // #189: the spec 7.2 operator re-drive marks a stale dead outbox row superseded.
  it('outbox: a dead row may be marked superseded', async () => {
    const err = await attempt(sql, async (tx) => {
      await tx`INSERT INTO bastion_outbox (organization_id, kind, ordering_key, idempotency_key, status)
               VALUES (${ORG}, 'bam_task_upsert', ${`control:${CONTROL}`}, 'immut-test-1', 'dead')`;
      await tx`UPDATE bastion_outbox SET status = 'superseded' WHERE idempotency_key = 'immut-test-1'`;
    });
    expect(err).toBeNull();
  });

  // #188: exception-expiry drift is idempotent per (org, exception, control).
  it('drift events: a second exception-expiry drift row for the same exception conflicts', async () => {
    const insertDrift = (tx: Tx) =>
      tx`INSERT INTO bastion_drift_events (organization_id, control_id, exception_id, from_status, to_status, reason)
         VALUES (${ORG}, ${CONTROL}, ${EXCEPTION}, 'pass_with_exception', 'fail', 'exception_expired')
         ON CONFLICT (organization_id, exception_id, control_id) WHERE exception_id IS NOT NULL DO NOTHING
         RETURNING id`;
    let first = -1;
    let second = -1;
    const err = await attempt(sql, async (tx) => {
      first = (await insertDrift(tx)).length;
      second = (await insertDrift(tx)).length;
    });
    expect(err).toBeNull();
    expect(first).toBe(1);
    expect(second).toBe(0);
    const noCause = await attempt(
      sql,
      (tx) => tx`INSERT INTO bastion_drift_events (organization_id, control_id, from_status, to_status, reason)
                 VALUES (${ORG}, ${CONTROL}, 'pass_with_exception', 'fail', 'exception_expired')`,
    );
    expect(noCause).toMatch(/23514/);
  });

  // #187: resuming a partial nightly run waits while a manual/agent full run is live.
  it('evaluation runs: bastion_resume_partial_run defers while a full run is live, then resumes', async () => {
    const outcomes: boolean[] = [];
    const err = await attempt(sql, async (tx) => {
      const [nightly] = await tx<Array<{ id: string }>>`
        INSERT INTO bastion_evaluation_runs (organization_id, trigger, scope, nightly_for_date, as_of, status)
        VALUES (${ORG}, 'nightly', 'all', current_date, now(), 'partial') RETURNING id`;
      const [manual] = await tx<Array<{ id: string }>>`
        INSERT INTO bastion_evaluation_runs (organization_id, trigger, scope, as_of, status)
        VALUES (${ORG}, 'manual', 'all', now(), 'running') RETURNING id`;
      const deferred = await tx<Array<{ ok: boolean }>>`SELECT bastion_resume_partial_run(${nightly!.id}::uuid) AS ok`;
      outcomes.push(deferred[0]!.ok);
      await tx`UPDATE bastion_evaluation_runs SET status = 'succeeded' WHERE id = ${manual!.id}`;
      const resumed = await tx<Array<{ ok: boolean }>>`SELECT bastion_resume_partial_run(${nightly!.id}::uuid) AS ok`;
      outcomes.push(resumed[0]!.ok);
      const [row] = await tx<Array<{ status: string; resume_count: number }>>`
        SELECT status, resume_count FROM bastion_evaluation_runs WHERE id = ${nightly!.id}`;
      outcomes.push(row!.status === 'queued' && row!.resume_count === 1);
    });
    expect(err).toBeNull();
    expect(outcomes).toEqual([false, true, true]);
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
