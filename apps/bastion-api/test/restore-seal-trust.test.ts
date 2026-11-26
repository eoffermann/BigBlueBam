import { describe, expect, it } from 'vitest';
import { parseSeal, sealIsAuthentic } from '../src/engine/restore.js';
import { sealSignerFromSeed, signSeal } from '../src/lib/ledger-canonical.js';

// Issue #199: bucket seal objects are trusted only when signed by a published key, and their
// identity must fit the integer / bigint columns it is written into.

const ORG = '00000000-0000-4000-8000-0000ba574199';
const signer = sealSignerFromSeed('5'.repeat(64));
const published = new Map([[signer.keyId, signer.publicKeyHex]]);
const base = { org: ORG, seal_date: '2026-11-26', epoch: 1, head_seq: 7, head_hash: 'a'.repeat(64), signing_key_id: signer.keyId };
const signed = (p: typeof base) => ({ ...p, signature: signSeal(p, signer) });

describe('bucket seal trust (#199)', () => {
  it('a correctly signed seal parses and verifies', () => {
    const seal = parseSeal(signed(base), 'k');
    expect(seal).not.toBeNull();
    expect(sealIsAuthentic(seal!, published)).toBe(true);
  });

  it('an unsigned or tampered seal does not verify', () => {
    expect(sealIsAuthentic(parseSeal({ ...base, signature: 'x' }, 'k')!, published)).toBe(false);
    const tampered = { ...signed(base), head_seq: 999_999_999 };
    expect(sealIsAuthentic(parseSeal(tampered, 'k')!, published)).toBe(false);
  });

  it('a seal signed by an unpublished key does not verify', () => {
    const rogue = sealSignerFromSeed('7'.repeat(64));
    const p = { ...base, signing_key_id: rogue.keyId };
    expect(sealIsAuthentic(parseSeal({ ...p, signature: signSeal(p, rogue) }, 'k')!, published)).toBe(false);
  });

  it('epoch and head_seq are bounded to their column ranges', () => {
    expect(parseSeal(signed({ ...base, epoch: 2_147_483_647 }), 'k')).toBeNull();
    expect(parseSeal(signed({ ...base, epoch: 2_147_483_646 }), 'k')).not.toBeNull();
    expect(parseSeal(signed({ ...base, epoch: 0 }), 'k')).toBeNull();
    expect(parseSeal(signed({ ...base, head_seq: -1 }), 'k')).toBeNull();
    expect(parseSeal(signed({ ...base, head_seq: 2 ** 53 }), 'k')).toBeNull();
  });

  it('malformed shapes are rejected', () => {
    expect(parseSeal(null, 'k')).toBeNull();
    expect(parseSeal({ ...signed(base), epoch: '1' }, 'k')).toBeNull();
    expect(parseSeal({ ...signed(base), head_hash: 'zz' }, 'k')).toBeNull();
    expect(parseSeal({ ...signed(base), seal_date: '2026-11-26T00:00:00Z' }, 'k')).toBeNull();
    const { signature: _s, ...unsigned } = signed(base);
    expect(parseSeal(unsigned, 'k')).toBeNull();
  });
});
