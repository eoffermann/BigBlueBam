import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  canonicalJson,
  compareEpochSeq,
  entryHash,
  GENESIS_HASH,
  rowHashIntact,
  sealSignerFromSeed,
  signSeal,
  signingKeyIdOf,
  toRecordedAt,
  verifyChain,
  verifySeal,
  type LedgerEntryFields,
  type LedgerRow,
} from '../src/lib/ledger-canonical.js';

const ORG = '00000000-0000-4000-8000-0000ba574001';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const FIELDS: LedgerEntryFields = {
  org: ORG,
  epoch: 1,
  seq: 1,
  kind: 'snapshot',
  id: '00000000-0000-4000-8000-0000ba574002',
  content_sha256: 'a'.repeat(64),
  personal_data_hmac: null,
  pd_hmac_key_id: null,
  prev: GENESIS_HASH,
  recorded_at: '2026-11-26T03:17:00.123Z',
};

// The canonical string is written out by hand: sorted keys, no whitespace, integers as integers,
// null for absent commitments. If the canonicalizer ever changes, this golden breaks.
const GOLDEN_CANONICAL =
  `{"content_sha256":"${'a'.repeat(64)}","epoch":1,"id":"00000000-0000-4000-8000-0000ba574002",` +
  `"kind":"snapshot","org":"${ORG}","pd_hmac_key_id":null,"personal_data_hmac":null,` +
  `"prev":"${'0'.repeat(64)}","recorded_at":"2026-11-26T03:17:00.123Z","seq":1}`;

describe('ledger canonical form (spec 3.4)', () => {
  it('canonical JSON sorts keys, drops whitespace and keeps integers', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: 'x' }] })).toBe('{"a":[2,{"c":"x","d":null}],"b":1}');
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
  });

  it('entry_hash matches the hand-written golden, including epoch', () => {
    expect(entryHash(FIELDS)).toBe(sha(GOLDEN_CANONICAL));
  });

  it('every field is committed: changing any one changes the hash', () => {
    const base = entryHash(FIELDS);
    const variants: Partial<LedgerEntryFields>[] = [
      { epoch: 2 },
      { seq: 2 },
      { kind: 'restore' },
      { id: '00000000-0000-4000-8000-0000ba574003' },
      { content_sha256: 'b'.repeat(64) },
      { personal_data_hmac: 'c'.repeat(64) },
      { pd_hmac_key_id: 'pd:1' },
      { prev: '1'.repeat(64) },
      { recorded_at: '2026-11-26T03:17:00.124Z' },
      { org: '00000000-0000-4000-8000-0000ba574009' },
    ];
    for (const v of variants) expect(entryHash({ ...FIELDS, ...v }), JSON.stringify(v)).not.toBe(base);
  });

  it('recorded_at is truncated to milliseconds, UTC with Z', () => {
    expect(toRecordedAt(new Date('2026-11-26T03:17:00.123Z'))).toBe('2026-11-26T03:17:00.123Z');
  });

  it('a row read back from Postgres (string seq, Date recorded_at) verifies; a tampered one does not', () => {
    const row: LedgerRow = {
      organization_id: ORG,
      epoch: 1,
      seq: '1',
      entry_kind: 'snapshot',
      entry_id: FIELDS.id,
      content_sha256: FIELDS.content_sha256,
      personal_data_hmac: null,
      pd_hmac_key_id: null,
      prev_entry_hash: GENESIS_HASH,
      entry_hash: entryHash(FIELDS),
      recorded_at: new Date(FIELDS.recorded_at),
    };
    expect(rowHashIntact(row)).toBe(true);
    expect(rowHashIntact({ ...row, content_sha256: 'f'.repeat(64) })).toBe(false);
  });

  it('verifyChain reports a broken prev link and a rewritten row', () => {
    const first = { ...FIELDS };
    const h1 = entryHash(first);
    const second = { ...FIELDS, seq: 2, id: '00000000-0000-4000-8000-0000ba574004', prev: h1 };
    const h2 = entryHash(second);
    const toRow = (f: LedgerEntryFields, h: string): LedgerRow => ({
      organization_id: f.org,
      epoch: f.epoch,
      seq: f.seq,
      entry_kind: f.kind,
      entry_id: f.id,
      content_sha256: f.content_sha256,
      personal_data_hmac: f.personal_data_hmac,
      pd_hmac_key_id: f.pd_hmac_key_id,
      prev_entry_hash: f.prev,
      entry_hash: h,
      recorded_at: f.recorded_at,
    });
    expect(verifyChain([toRow(first, h1), toRow(second, h2)])).toEqual([]);
    expect(verifyChain([toRow(first, h1), toRow({ ...second, prev: GENESIS_HASH }, entryHash({ ...second, prev: GENESIS_HASH }))])).toEqual([
      { seq: 2, problem: 'prev_mismatch', expected_prev: h1 },
    ]);
    expect(verifyChain([toRow(first, h1), { ...toRow(second, h2), content_sha256: 'e'.repeat(64) }])[0]?.problem).toBe('hash_mismatch');
  });

  it('(epoch, seq) ordering compares epoch first', () => {
    expect(compareEpochSeq({ epoch: 2, seq: 1 }, { epoch: 1, seq: 99 })).toBeGreaterThan(0);
    expect(compareEpochSeq({ epoch: 1, seq: 5 }, { epoch: 1, seq: 6 })).toBeLessThan(0);
  });
});

describe('seals (Ed25519, multiple signing keys)', () => {
  const oldSigner = sealSignerFromSeed('1'.repeat(64));
  const newSigner = sealSignerFromSeed('2'.repeat(64));
  const payload = (keyId: string) => ({
    org: ORG,
    seal_date: '2026-11-26',
    epoch: 1,
    head_seq: 42,
    head_hash: 'd'.repeat(64),
    signing_key_id: keyId,
  });

  it('derives a stable key id from the public key', () => {
    expect(oldSigner.keyId).toBe(signingKeyIdOf(oldSigner.publicKeyHex));
    expect(oldSigner.keyId).not.toBe(newSigner.keyId);
    expect(sealSignerFromSeed('1'.repeat(64)).publicKeyHex).toBe(oldSigner.publicKeyHex);
  });

  it('a seal signed with a retired key still verifies when its public key is published', () => {
    const oldSeal = payload(oldSigner.keyId);
    const sig = signSeal(oldSeal, oldSigner);
    const published = new Map([
      [newSigner.keyId, newSigner.publicKeyHex],
      [oldSigner.keyId, oldSigner.publicKeyHex],
    ]);
    expect(verifySeal(oldSeal, sig, published)).toBe(true);
    expect(verifySeal(oldSeal, sig, new Map([[newSigner.keyId, newSigner.publicKeyHex]]))).toBe(false);
  });

  it('any change to a sealed field breaks the signature', () => {
    const p = payload(newSigner.keyId);
    const sig = signSeal(p, newSigner);
    const keys = new Map([[newSigner.keyId, newSigner.publicKeyHex]]);
    expect(verifySeal(p, sig, keys)).toBe(true);
    expect(verifySeal({ ...p, head_seq: 41 }, sig, keys)).toBe(false);
    expect(verifySeal({ ...p, epoch: 2 }, sig, keys)).toBe(false);
  });

  it('refuses to sign a payload naming another key', () => {
    expect(() => signSeal(payload(oldSigner.keyId), newSigner)).toThrow();
  });
});
