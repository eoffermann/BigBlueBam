import { describe, it, expect } from 'vitest';
import { parseOfferDocument } from '../src/services/engines/parse.engine.js';
import { DEFAULT_DOC_LIMITS } from '../src/services/engines/parse-logic.js';
import {
  LEGIT_NODES,
  LEGIT_OFFER_TEXT,
  pdfImageOnly,
  specSettings,
  SPLIT_BLANKET_NODES,
  SPLIT_BLANKET_TEXT,
} from './fixtures/offer-documents.js';

// The load-bearing M4 test (spec 4.6 / M4 done-when): the split-blanket fixture ingests, parses,
// quarantines, and opens an offer_manipulation_suspected finding, with the two §4.3 counters
// computed PER OFFER. This asserts the pure engine outcome the store persists.
describe('parseOfferDocument: split-blanket (spec 4.6)', () => {
  const outcome = parseOfferDocument({
    buf: Buffer.from(SPLIT_BLANKET_TEXT, 'utf8'),
    declaredFormat: 'text',
    nodes: SPLIT_BLANKET_NODES,
    settings: specSettings(),
    byteLen: Buffer.byteLength(SPLIT_BLANKET_TEXT, 'utf8'),
  });

  it('parses cleanly enough to measure (above the quality floor), NOT unparseable', () => {
    expect(outcome.status).toBe('parsed');
    expect(outcome.parse_quality).toBeGreaterThan(0.35);
  });

  it('carries NO blanket-lexicon token yet still quarantines', () => {
    expect(outcome.blanket_lines).toBe(0);
    expect(outcome.blanket_suspected).toBe(true);
    expect(outcome.manipulation.suspected).toBe(true);
  });

  it('opens the finding via the §4.3 cumulative + concentration caps', () => {
    expect(outcome.manipulation.reasons).toContain('cumulative_cap');
    expect(outcome.manipulation.reasons).toContain('evidence_concentration');
  });

  it('persists the two per-offer counters (14 unsub-priced mandatory nodes, 4 lines / 14 = 0.29)', () => {
    expect(outcome.counters.unsubpriced_mandatory_count).toBe(14);
    expect(outcome.counters.evidence_concentration).toBeCloseTo(0.2857, 3);
  });
});

describe('parseOfferDocument: parse_quality floor gates absence (spec 4.1)', () => {
  it('a sparse read is unparseable and produces NO matches (cannot yield absent)', () => {
    const outcome = parseOfferDocument({
      buf: Buffer.from('see attached', 'utf8'),
      declaredFormat: 'text',
      nodes: SPLIT_BLANKET_NODES,
      settings: specSettings(),
      byteLen: 12,
    });
    expect(outcome.status).toBe('unparseable');
    expect(outcome.error).toMatch(/below floor/);
    expect(outcome.matches).toHaveLength(0);
    expect(outcome.counters.unsubpriced_mandatory_count).toBe(0);
    expect(outcome.counters.evidence_concentration).toBeNull();
  });

  it('an image-only PDF is unparseable, never levelled (no OCR in v1)', () => {
    const outcome = parseOfferDocument({
      buf: pdfImageOnly(),
      declaredFormat: 'pdf',
      nodes: [],
      settings: specSettings(),
      byteLen: pdfImageOnly().length,
    });
    expect(outcome.status).toBe('unparseable');
    expect(outcome.image_only).toBe(true);
    expect(outcome.error).toMatch(/no readable text layer/);
  });
});

describe('parseOfferDocument: malicious-document ceilings (spec 5.4)', () => {
  it('an oversize document is blocked with the 20MB message', () => {
    const outcome = parseOfferDocument({
      buf: Buffer.from('x', 'utf8'),
      declaredFormat: 'text',
      nodes: [],
      settings: specSettings(),
      byteLen: DEFAULT_DOC_LIMITS.maxDocBytes + 1,
    });
    expect(outcome.status).toBe('blocked');
    expect(outcome.error).toBe('this file is larger than 20MB');
    expect(outcome.lines).toHaveLength(0);
  });
});

describe('parseOfferDocument: a legitimate offer is NOT quarantined (false-positive guard)', () => {
  it('parses, matches only referenced nodes, and trips no cap', () => {
    const outcome = parseOfferDocument({
      buf: Buffer.from(LEGIT_OFFER_TEXT, 'utf8'),
      declaredFormat: 'text',
      nodes: LEGIT_NODES,
      settings: specSettings(),
      byteLen: Buffer.byteLength(LEGIT_OFFER_TEXT, 'utf8'),
    });
    expect(outcome.status).toBe('parsed');
    expect(outcome.blanket_suspected).toBe(false);
    expect(outcome.manipulation.suspected).toBe(false);
    // Two mandatory nodes (Installation, Training) covered by their own lines: concentration 1.0.
    expect(outcome.counters.unsubpriced_mandatory_count).toBe(2);
    expect(outcome.counters.evidence_concentration).toBeCloseTo(1.0, 5);
  });
});
