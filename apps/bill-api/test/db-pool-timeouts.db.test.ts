/**
 * Issue #169: bill-api's pool must not let a request wait on a row lock, or sit
 * idle inside a transaction, long enough to drain the pool. The invariant is
 * checked where it is consumed: on a session the real pool hands out.
 *
 * Runs whenever DATABASE_URL points at a database; skips otherwise.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';

const DATABASE_URL = process.env.DATABASE_URL;
vi.mock('../src/env.js', () => ({ env: { DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://unused' } }));

describe.skipIf(!DATABASE_URL)('bill-api pool session timeouts (issue #169, real DB)', () => {
  let mod: typeof import('../src/db/index.js') | undefined;

  afterAll(async () => {
    await mod?.connection.end({ timeout: 5 });
  });

  it('sets lock_timeout and idle_in_transaction_session_timeout on pooled sessions, including inside transactions', async () => {
    mod = await import('../src/db/index.js');
    const rowsOf = (r: unknown) => (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<Record<string, string>>;
    const lock = rowsOf(await mod.db.execute(sql`SHOW lock_timeout`))[0]!;
    const idle = rowsOf(await mod.db.execute(sql`SHOW idle_in_transaction_session_timeout`))[0]!;
    expect(lock.lock_timeout).toBe('10s');
    expect(idle.idle_in_transaction_session_timeout).toBe('1min');
    const inTx = await mod.db.transaction(async (tx) => rowsOf(await tx.execute(sql`SHOW lock_timeout`))[0]!);
    expect(inTx.lock_timeout).toBe('10s');
  });
});
