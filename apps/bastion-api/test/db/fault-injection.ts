import type postgres from 'postgres';

/**
 * Deterministic database fault injection for the DB-backed suites, with NO DDL while tests run (#320).
 *
 * The b11 suites used to CREATE and DROP triggers on shared tables (bastion_assertions,
 * bastion_compile_runs, bastion_ingest_events) inside their tests. In a full parallel run every
 * other file writes those tables at the same moment, so the DDL raced on the catalog
 * ("tuple concurrently updated", seen failing the #241 and MAX_RESUMES cases) and, while it waited
 * for its table lock, queued every other suite's statements on that table behind it (hook timeouts
 * elsewhere, and 55P03 in engine transactions that run under lock_timeout).
 *
 * Now the triggers are installed ONCE, by the db project's globalSetup before any test file starts,
 * in their own schema (so db:check and wipeOrg, which look at public bastion_* tables, never see
 * them), and removed by its teardown. A test injects a fault with a plain INSERT into
 * bbb_test_faults.faults keyed by its own row ids, and removes it with a DELETE: no DDL on a shared
 * table, no catalog race, no lock queue. With no fault rows the trigger function returns at once.
 */

export const FAULT_SCHEMA = 'bbb_test_faults';

/** Tables and operations a fault can target; one BEFORE ... FOR EACH ROW trigger each. */
export const FAULT_TARGETS = [
  { table: 'bastion_assertions', op: 'INSERT' },
  { table: 'bastion_compile_runs', op: 'UPDATE' },
  { table: 'bastion_ingest_events', op: 'UPDATE' },
  { table: 'bastion_questionnaire_items', op: 'UPDATE' },
] as const;
export type FaultTarget = (typeof FAULT_TARGETS)[number];

const triggerName = (t: FaultTarget) => `bbb_test_fault_${t.table}`;

/** Install the schema, the fault table, the trigger function and one trigger per target (idempotent). */
export async function installFaultTriggers(sql: postgres.Sql): Promise<void> {
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${FAULT_SCHEMA}`);
  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${FAULT_SCHEMA}.faults (
      id          bigserial PRIMARY KEY,
      table_name  text  NOT NULL,
      op          text  NOT NULL,
      match       jsonb NOT NULL,
      changed_col text,
      once_seq    text,
      sqlstate    text  NOT NULL,
      message     text  NOT NULL
    )`);
  await sql.unsafe(`
    -- SECURITY DEFINER with a pinned search_path: a test that writes as a NOBYPASSRLS role (the
    -- probe goldens SET LOCAL ROLE) still reads the fault table and its sequences.
    CREATE OR REPLACE FUNCTION ${FAULT_SCHEMA}.fire() RETURNS trigger LANGUAGE plpgsql
    SECURITY DEFINER SET search_path = pg_catalog, ${FAULT_SCHEMA} AS $f$
    DECLARE f record;
    BEGIN
      FOR f IN SELECT * FROM ${FAULT_SCHEMA}.faults WHERE table_name = TG_TABLE_NAME AND op = TG_OP LOOP
        IF to_jsonb(NEW) @> f.match
           AND (f.changed_col IS NULL OR TG_OP <> 'UPDATE'
                OR (to_jsonb(NEW) -> f.changed_col) IS DISTINCT FROM (to_jsonb(OLD) -> f.changed_col))
           -- A sequence is not rolled back with the failed statement, so a once-only fault stays fired.
           AND (f.once_seq IS NULL OR nextval(f.once_seq::regclass) = 1) THEN
          RAISE EXCEPTION USING MESSAGE = f.message, ERRCODE = f.sqlstate;
        END IF;
      END LOOP;
      RETURN NEW;
    END $f$`);
  for (const t of FAULT_TARGETS) {
    await sql.unsafe(
      `DROP TRIGGER IF EXISTS ${triggerName(t)} ON public.${t.table};
       CREATE TRIGGER ${triggerName(t)} BEFORE ${t.op} ON public.${t.table} FOR EACH ROW EXECUTE FUNCTION ${FAULT_SCHEMA}.fire()`,
    );
  }
}

/** Remove every trigger and the schema (after the last test file). */
export async function removeFaultTriggers(sql: postgres.Sql): Promise<void> {
  for (const t of FAULT_TARGETS) await sql.unsafe(`DROP TRIGGER IF EXISTS ${triggerName(t)} ON public.${t.table}`);
  await sql.unsafe(`DROP SCHEMA IF EXISTS ${FAULT_SCHEMA} CASCADE`);
}

export interface FaultSpec {
  target: FaultTarget;
  /** Fires for a row whose to_jsonb(NEW) contains this (ids as strings). Key it on the test's own rows. */
  match: Record<string, string | number | boolean>;
  /** UPDATE only: fire only when this column changes. */
  changedCol?: string;
  /** Fire on the first matching row only, ever. */
  once?: boolean;
  sqlstate: string;
  message: string;
}

/** Inject one fault (DML only); returns a function that removes it. */
export async function injectFault(sql: postgres.Sql, spec: FaultSpec): Promise<() => Promise<void>> {
  let onceSeq: string | null = null;
  if (spec.once) {
    // A new sequence in the test schema: a new relation, so it touches no shared table's catalog row.
    const [row] = await sql`SELECT 'f' || replace(gen_random_uuid()::text, '-', '') AS n`;
    onceSeq = `${FAULT_SCHEMA}.${String(row!.n)}`;
    await sql.unsafe(`CREATE SEQUENCE ${onceSeq}`);
  }
  const [f] = await sql`
    INSERT INTO ${sql(FAULT_SCHEMA)}.faults (table_name, op, match, changed_col, once_seq, sqlstate, message)
    VALUES (${spec.target.table}, ${spec.target.op}, ${sql.json(spec.match)}, ${spec.changedCol ?? null}, ${onceSeq}, ${spec.sqlstate}, ${spec.message})
    RETURNING id`;
  return async () => {
    await sql`DELETE FROM ${sql(FAULT_SCHEMA)}.faults WHERE id = ${f!.id as string}`;
    if (onceSeq) await sql.unsafe(`DROP SEQUENCE IF EXISTS ${onceSeq}`);
  };
}

export const ASSERTION_INSERT = FAULT_TARGETS[0];
export const COMPILE_RUN_UPDATE = FAULT_TARGETS[1];
export const INGEST_EVENT_UPDATE = FAULT_TARGETS[2];
export const QUESTIONNAIRE_ITEM_UPDATE = FAULT_TARGETS[3];
