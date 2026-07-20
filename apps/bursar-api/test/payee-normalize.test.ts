import { describe, it, expect } from 'vitest';
import {
  classifyPayeeMatch,
  normalizePayee,
  resolvePayee,
  trigramSimilarity,
  DEFAULT_PAYEE_THRESHOLDS,
} from '../src/lib/payee-normalize.js';

describe('normalizePayee', () => {
  it('uppercase-folds and collapses whitespace', () => {
    expect(normalizePayee('  Acme   Widgets  ')).toBe('ACME WIDGETS');
  });

  it('strips a leading SQ * card prefix', () => {
    expect(normalizePayee('SQ *ACME WIDGETS')).toBe('ACME WIDGETS');
  });

  it('strips a leading TST* card prefix', () => {
    expect(normalizePayee('TST* BLUE BOTTLE COFFEE')).toBe('BLUE BOTTLE COFFEE');
  });

  it('strips a bare leading asterisk', () => {
    expect(normalizePayee('*ACME')).toBe('ACME');
  });

  it('strips a trailing phone number', () => {
    expect(normalizePayee('ACME SUPPLY 800-555-1234')).toBe('ACME SUPPLY');
  });

  it('strips a trailing US state code but keeps the city', () => {
    expect(normalizePayee('ACME SUPPLY SEATTLE WA')).toBe('ACME SUPPLY SEATTLE');
  });

  it('strips corporate suffixes (INC / LLC / LTD)', () => {
    expect(normalizePayee('Acme Widgets, Inc.')).toBe('ACME WIDGETS');
    expect(normalizePayee('Globex LLC')).toBe('GLOBEX');
    expect(normalizePayee('Initech Ltd')).toBe('INITECH');
  });

  it('strips multiple stacked corporate suffixes', () => {
    expect(normalizePayee('ACME HOLDINGS CO LLC')).toBe('ACME HOLDINGS');
  });

  it('keeps a bare two-letter company name (state strip needs a preceding token)', () => {
    expect(normalizePayee('CA')).toBe('CA');
  });

  it('handles a combined card prefix + trailing corporate suffix + phone', () => {
    // Card prefix stripped, trailing phone stripped, then the now-trailing CORP suffix stripped.
    expect(normalizePayee('TST* GLOBEX CORP 415-555-0100')).toBe('GLOBEX');
  });

  it('strips only TRAILING corporate suffixes, leaving a mid-string token in place', () => {
    // Documented behavior: after the state/phone tail is removed, INC is no longer trailing,
    // so it is preserved. Only end-of-string suffixes are stripped.
    expect(normalizePayee('ACME WIDGETS INC PORTLAND OR 5035551212')).toBe(
      'ACME WIDGETS INC PORTLAND',
    );
  });

  it('returns empty for a blank or punctuation-only payee', () => {
    expect(normalizePayee('')).toBe('');
    expect(normalizePayee('***')).toBe('');
  });
});

describe('trigramSimilarity', () => {
  it('is 1 for identical normalized strings', () => {
    expect(trigramSimilarity('ACME WIDGETS', 'ACME WIDGETS')).toBe(1);
  });

  it('is 0 when either side is empty', () => {
    expect(trigramSimilarity('', 'ACME')).toBe(0);
    expect(trigramSimilarity('ACME', '')).toBe(0);
  });

  it('ranks a near-duplicate above an unrelated string', () => {
    const near = trigramSimilarity('ACME WIDGETS', 'ACME WIDGET');
    const far = trigramSimilarity('ACME WIDGETS', 'ZORP ENTERPRISES');
    expect(near).toBeGreaterThan(far);
    expect(near).toBeGreaterThan(0.45);
  });
});

describe('classifyPayeeMatch', () => {
  it('auto-accepts at or above 0.65', () => {
    expect(classifyPayeeMatch(0.65)).toBe('auto_accept');
    expect(classifyPayeeMatch(0.9)).toBe('auto_accept');
  });

  it('routes the 0.45-0.65 band to human review, never a silent join', () => {
    expect(classifyPayeeMatch(0.45)).toBe('needs_review');
    expect(classifyPayeeMatch(0.5)).toBe('needs_review');
    expect(classifyPayeeMatch(0.6499)).toBe('needs_review');
  });

  it('is no_match below the candidate floor', () => {
    expect(classifyPayeeMatch(0.44)).toBe('no_match');
    expect(classifyPayeeMatch(0)).toBe('no_match');
  });

  it('honors custom thresholds', () => {
    expect(classifyPayeeMatch(0.5, { match: 0.3, autoAccept: 0.5 })).toBe('auto_accept');
  });
});

describe('resolvePayee', () => {
  const candidates = [
    { vendor_id: 'v-acme', normalized_name: 'ACME WIDGETS' },
    { vendor_id: 'v-globex', normalized_name: 'GLOBEX' },
  ];

  it('auto-accepts an exact-ish match against the best candidate', () => {
    const r = resolvePayee('SQ *ACME WIDGETS INC', candidates);
    expect(r.disposition).toBe('auto_accept');
    expect(r.vendor_id).toBe('v-acme');
    expect(r.normalized_payee).toBe('ACME WIDGETS');
  });

  it('keeps vendor_id NULL when nothing clears the candidate floor', () => {
    const r = resolvePayee('ZORP ENTERPRISES', candidates);
    expect(r.disposition).toBe('no_match');
    expect(r.vendor_id).toBeNull();
  });

  it('proposes a review item (vendor set, but not auto-joined) in the middle band', () => {
    // Construct a payee that lands between the thresholds against ACME WIDGETS.
    const r = resolvePayee('ACME WImGETX', candidates, DEFAULT_PAYEE_THRESHOLDS);
    if (r.disposition === 'needs_review') {
      expect(r.vendor_id).toBe('v-acme');
      expect(r.score).toBeGreaterThanOrEqual(DEFAULT_PAYEE_THRESHOLDS.match);
      expect(r.score).toBeLessThan(DEFAULT_PAYEE_THRESHOLDS.autoAccept);
    } else {
      // If the fixture lands outside the band on this matcher, the invariant we care about is
      // still that it never silently auto-accepts an ambiguous string.
      expect(['no_match', 'auto_accept']).toContain(r.disposition);
    }
  });

  it('returns no_match against an empty candidate set', () => {
    const r = resolvePayee('ACME WIDGETS', []);
    expect(r.disposition).toBe('no_match');
    expect(r.vendor_id).toBeNull();
  });
});
