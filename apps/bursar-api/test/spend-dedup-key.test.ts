import { describe, it, expect } from 'vitest';
import {
  spendDedupKey,
  assignOccurrenceOrdinals,
  type SpendRowInput,
} from '../src/lib/spend-dedup-key.js';

// M8: the spend dedup key is a PLAIN LOCAL sha256 (not secret-keyed) so it is stable across runs
// and secret rotations, and occurrence_ordinal makes two genuine identical same-day charges into
// two distinct rows.

const CHARGE: SpendRowInput = {
  normalized_payee: 'ACME WIDGETS',
  occurred_on: '2026-06-01',
  amount_minor: 12_500,
  currency: 'USD',
  external_ref: null,
};

describe('spendDedupKey', () => {
  it('is a 64-char lowercase hex sha256', () => {
    const key = spendDedupKey({ ...CHARGE, occurrence_ordinal: 0 });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is stable across runs (deterministic, not process-random / not secret-keyed)', () => {
    const a = spendDedupKey({ ...CHARGE, occurrence_ordinal: 0 });
    const b = spendDedupKey({ ...CHARGE, occurrence_ordinal: 0 });
    expect(a).toBe(b);
  });

  it('changes when the ordinal changes (so identical charges get distinct keys)', () => {
    const zero = spendDedupKey({ ...CHARGE, occurrence_ordinal: 0 });
    const one = spendDedupKey({ ...CHARGE, occurrence_ordinal: 1 });
    expect(zero).not.toBe(one);
  });

  it('changes on any tuple field (payee, date, amount, currency, ref)', () => {
    const base = spendDedupKey({ ...CHARGE, occurrence_ordinal: 0 });
    expect(spendDedupKey({ ...CHARGE, normalized_payee: 'OTHER', occurrence_ordinal: 0 })).not.toBe(base);
    expect(spendDedupKey({ ...CHARGE, occurred_on: '2026-06-02', occurrence_ordinal: 0 })).not.toBe(base);
    expect(spendDedupKey({ ...CHARGE, amount_minor: 12_501, occurrence_ordinal: 0 })).not.toBe(base);
    expect(spendDedupKey({ ...CHARGE, currency: 'EUR', occurrence_ordinal: 0 })).not.toBe(base);
    expect(spendDedupKey({ ...CHARGE, external_ref: 'INV-9', occurrence_ordinal: 0 })).not.toBe(base);
  });

  it('is length-prefixed so field boundaries cannot be shifted by crafted content', () => {
    // ('AB','') vs ('A','B') must not collide.
    const left = spendDedupKey({ ...CHARGE, normalized_payee: 'AB', external_ref: '', occurrence_ordinal: 0 });
    const right = spendDedupKey({ ...CHARGE, normalized_payee: 'A', external_ref: 'B', occurrence_ordinal: 0 });
    expect(left).not.toBe(right);
  });
});

describe('assignOccurrenceOrdinals', () => {
  it('gives two genuine identical same-day charges distinct ordinals and keys (two rows)', () => {
    const out = assignOccurrenceOrdinals([{ ...CHARGE }, { ...CHARGE }]);
    expect(out[0]!.occurrence_ordinal).toBe(0);
    expect(out[1]!.occurrence_ordinal).toBe(1);
    expect(out[0]!.dedup_key).not.toBe(out[1]!.dedup_key);
  });

  it('numbers each dedup group independently and preserves file order', () => {
    const other: SpendRowInput = { ...CHARGE, normalized_payee: 'GLOBEX', amount_minor: 500 };
    const out = assignOccurrenceOrdinals([{ ...CHARGE }, { ...other }, { ...CHARGE }]);
    expect(out.map((r) => r.occurrence_ordinal)).toEqual([0, 0, 1]);
    // The two ACME rows are distinct; the GLOBEX row is its own group at ordinal 0.
    expect(out[0]!.dedup_key).not.toBe(out[2]!.dedup_key);
    expect(out[1]!.occurrence_ordinal).toBe(0);
  });

  it('re-deriving keys for the same file is stable (idempotent import contract)', () => {
    const first = assignOccurrenceOrdinals([{ ...CHARGE }, { ...CHARGE }]);
    const second = assignOccurrenceOrdinals([{ ...CHARGE }, { ...CHARGE }]);
    expect(first.map((r) => r.dedup_key)).toEqual(second.map((r) => r.dedup_key));
  });
});
