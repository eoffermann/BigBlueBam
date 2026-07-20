import { describe, it, expect } from 'vitest';
import {
  prepareSpendEvents,
  runSpendImport,
  type SpendImportStore,
  type PreparedSpendEvent,
  type SpendImportRow,
} from '../src/services/engines/spend-import.js';

// M8: import resumability + the "0 new derives from rows_deduped, never from batch existence"
// contract, proven against an in-memory store that can simulate a crash mid-insert.

/**
 * An in-memory store. `crashAfter` makes insertEvents insert only the first N of the batch that
 * are NEW, then throw - modelling a process kill at row N. The inserted keys SURVIVE the crash
 * (they were committed row-by-row), so a retry resumes.
 */
function makeStore(opts: { crashAfter?: number } = {}) {
  const events = new Set<string>(); // dedup_keys that exist
  const batches = new Map<string, { status: string; row_count: number; rows_inserted: number; rows_deduped: number }>();
  let crashArmed = opts.crashAfter !== undefined;
  const store: SpendImportStore = {
    async upsertBatch(fileSha256) {
      const existing = batches.get(fileSha256);
      const priorStatus = existing?.status ?? null;
      if (!existing) batches.set(fileSha256, { status: 'running', row_count: 0, rows_inserted: 0, rows_deduped: 0 });
      else existing.status = 'running';
      return { importId: fileSha256, priorStatus };
    },
    async insertEvents(_importId, evts) {
      let inserted = 0;
      for (const e of evts) {
        if (events.has(e.dedup_key)) continue; // ON CONFLICT DO NOTHING
        if (crashArmed && inserted >= (opts.crashAfter ?? 0)) {
          crashArmed = false; // only crash once
          throw new Error('simulated crash mid-insert');
        }
        events.add(e.dedup_key);
        inserted += 1;
      }
      return inserted;
    },
    async finalizeBatch(importId, counts) {
      batches.set(importId, { status: 'succeeded', ...counts });
    },
  };
  return { store, events, batches };
}

function rowsFixture(n: number): SpendImportRow[] {
  // n distinct charges (distinct external_ref) so each is its own event.
  return Array.from({ length: n }, (_, i) => ({
    payee_raw: 'ACME WIDGETS',
    occurred_on: '2026-06-01',
    amount_minor: 1_000 + i,
    currency: 'USD',
    external_ref: `TXN-${i}`,
  }));
}

function prep(rows: SpendImportRow[]): PreparedSpendEvent[] {
  return prepareSpendEvents(rows, []);
}

describe('runSpendImport resumability', () => {
  it('imports all rows on a clean first run', async () => {
    const { store, events } = makeStore();
    const events412 = prep(rowsFixture(412));
    const res = await runSpendImport(store, { file_sha256: 'f'.repeat(64), filename: 'stmt.csv', events: events412 });
    expect(res.rows_inserted).toBe(412);
    expect(res.rows_deduped).toBe(0);
    expect(res.resumed).toBe(false);
    expect(events.size).toBe(412);
  });

  it('a crash at row 200 of 412 is retryable without losing the other 212', async () => {
    const events412 = prep(rowsFixture(412));
    const { store, events } = makeStore({ crashAfter: 200 });

    // First attempt crashes after 200 inserts.
    await expect(
      runSpendImport(store, { file_sha256: 'a'.repeat(64), filename: 'stmt.csv', events: events412 }),
    ).rejects.toThrow('simulated crash');
    expect(events.size).toBe(200); // 200 survived the crash

    // Retry with the SAME file: resumes, inserts the remaining 212, dedups the first 200.
    const res = await runSpendImport(store, { file_sha256: 'a'.repeat(64), filename: 'stmt.csv', events: events412 });
    expect(res.resumed).toBe(true);
    expect(res.rows_inserted).toBe(212);
    expect(res.rows_deduped).toBe(200);
    expect(events.size).toBe(412); // no rows lost
  });

  it('reports 0 new from rows_deduped on a full re-import (never from batch existence)', async () => {
    const events412 = prep(rowsFixture(412));
    const { store } = makeStore();
    await runSpendImport(store, { file_sha256: 'b'.repeat(64), filename: null, events: events412 });

    // Re-import the identical file: every row dedups.
    const res = await runSpendImport(store, { file_sha256: 'b'.repeat(64), filename: null, events: events412 });
    expect(res.rows_inserted).toBe(0); // "0 new"
    expect(res.rows_deduped).toBe(412); // derived from the dedup count, not from "batch exists"
    // A fully-succeeded batch re-run is idempotent, not a "resume" of a crashed one.
    expect(res.resumed).toBe(false);
  });

  it('two genuine identical same-day charges both import (occurrence_ordinal)', async () => {
    const identical: SpendImportRow[] = [
      { payee_raw: 'ACME', occurred_on: '2026-06-01', amount_minor: 5_000, currency: 'USD', external_ref: null },
      { payee_raw: 'ACME', occurred_on: '2026-06-01', amount_minor: 5_000, currency: 'USD', external_ref: null },
    ];
    const { store, events } = makeStore();
    const res = await runSpendImport(store, { file_sha256: 'c'.repeat(64), filename: null, events: prep(identical) });
    expect(res.rows_inserted).toBe(2);
    expect(events.size).toBe(2);
  });
});
