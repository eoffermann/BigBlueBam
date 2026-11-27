import { describe, expect, it } from 'vitest';
import { isTransientDbError } from '../src/engine/context.js';
import { chainBreakKey, entryHash, GENESIS_HASH, type LedgerRow, verifyChain } from '../src/lib/ledger-canonical.js';

/**
 * Review batch 17, units (no database):
 *   #295 a compile slice tells a transient database error from a deterministic one.
 *   #297 a chain break's dedupe key names the break as observed, not just its position.
 */

describe('chainBreakKey (#297)', () => {
  const ORG = '00000000-0000-4000-8000-0000ba574001';
  const fields = {
    org: ORG,
    epoch: 1,
    seq: 1,
    kind: 'snapshot' as const,
    id: '00000000-0000-4000-8000-0000ba574002',
    content_sha256: 'a'.repeat(64),
    personal_data_hmac: null,
    pd_hmac_key_id: null,
    prev: GENESIS_HASH,
    recorded_at: '2026-11-26T03:17:00.123Z',
  };
  const row: LedgerRow = {
    organization_id: ORG,
    epoch: 1,
    seq: 1,
    entry_kind: 'snapshot',
    entry_id: fields.id,
    content_sha256: fields.content_sha256,
    personal_data_hmac: null,
    pd_hmac_key_id: null,
    prev_entry_hash: GENESIS_HASH,
    entry_hash: entryHash(fields),
    recorded_at: fields.recorded_at,
  };
  const keyOf = (r: LedgerRow) => {
    const p = verifyChain([r])[0]!;
    return chainBreakKey(r, p);
  };

  it('is stable for one unrepaired break and new for a different tamper of the same row', () => {
    const tamperA = { ...row, content_sha256: 'e'.repeat(64) };
    const tamperB = { ...row, content_sha256: 'f'.repeat(64) };
    expect(keyOf(tamperA)).toBe(keyOf({ ...tamperA }));
    expect(keyOf(tamperA)).not.toBe(keyOf(tamperB));
    expect(keyOf(tamperA)).toMatch(/^evidence\.integrity_failed:chain:1:1:hash_mismatch:[0-9a-f]{32}$/);
  });

  it('names the epoch, so the same seq in a later epoch is a different break', () => {
    const tamper = { ...row, content_sha256: 'e'.repeat(64) };
    expect(keyOf(tamper)).not.toBe(keyOf({ ...tamper, epoch: 2 }));
  });
});

describe('isTransientDbError (#295)', () => {
  it('treats deadlocks, serialization failures, timeouts, restarts and dropped connections as transient', () => {
    for (const code of ['40P01', '40001', '55P03', '57014', '57P01', '57P03', '53300', '08006', '08003', 'CONNECTION_ENDED', 'CONNECTION_CLOSED', 'ECONNRESET']) {
      expect(isTransientDbError({ code })).toBe(true);
    }
    expect(isTransientDbError({ cause: { code: '40P01' } })).toBe(true);
  });

  it('treats data and constraint errors, and errors without a code, as deterministic', () => {
    for (const code of ['22P05', '23505', '23502', '42703', 'XX000']) expect(isTransientDbError({ code })).toBe(false);
    expect(isTransientDbError(new Error('boom'))).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
  });
});
