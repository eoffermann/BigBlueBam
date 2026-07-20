import { describe, it, expect } from 'vitest';
import {
  applyLexicons,
  assertDocCeilings,
  classifyLineRole,
  computeParseQuality,
  detectMagicFormat,
  extractText,
  pinContentType,
  segmentLines,
  DocCeilingError,
  DEFAULT_DOC_LIMITS,
} from '../src/services/engines/parse-logic.js';
import { DEFAULT_BLANKET_FALLBACK } from '../src/services/engines/parse.engine.js';
import {
  OFFER_CSV,
  OFFER_JSONL,
  pdfImageOnly,
  pdfWithTextLayer,
  zipMagicBuffer,
} from './fixtures/offer-documents.js';

// Stage 1 is deterministic (spec 4.1): every stage is provable against a fixture, no LLM.

describe('text extraction', () => {
  it('extracts a PDF text layer from Tj/TJ show operators', () => {
    const out = extractText(pdfWithTextLayer(), 'pdf');
    expect(out.imageOnly).toBe(false);
    expect(out.text).toContain('Installation and commissioning line item');
    expect(out.text).toContain('Warranty coverage, 24 months');
    expect(out.pages).toBeGreaterThanOrEqual(1);
  });

  it('flags an image-only PDF (no text layer) as unparseable, never levelled', () => {
    const out = extractText(pdfImageOnly(), 'pdf');
    expect(out.imageOnly).toBe(true);
    expect(out.text.trim()).toBe('');
  });

  it('parses CSV via the shared structured-data codec', () => {
    const out = extractText(Buffer.from(OFFER_CSV, 'utf8'), 'csv');
    expect(out.recordCount).toBe(3);
    expect(out.text).toContain('Installation');
    expect(out.text).toContain('42000');
  });

  it('parses JSONL via the shared structured-data codec', () => {
    const out = extractText(Buffer.from(OFFER_JSONL, 'utf8'), 'jsonl');
    expect(out.recordCount).toBe(3);
    expect(out.text).toContain('Warranty');
  });

  it('treats a raw XLSX container as unparseable (no zip extraction / OCR in v1)', () => {
    const out = extractText(zipMagicBuffer(), 'xlsx');
    expect(out.imageOnly).toBe(true);
  });
});

describe('line role classification (spec 4.4)', () => {
  it('classifies option / alternate / allowance / note / base', () => {
    expect(classifyLineRole('Option: extended warranty', true)).toBe('option');
    expect(classifyLineRole('Alternate: stainless housing in lieu of steel', false)).toBe('alternate');
    expect(classifyLineRole('Allowance for site preparation $5,000', true)).toBe('allowance');
    expect(classifyLineRole('Note: prices valid for 30 days', false)).toBe('note');
    expect(classifyLineRole('Installation and commissioning $42,000', true)).toBe('base');
  });

  it('segmentLines stamps roles, char offsets, and a parsed amount', () => {
    const lines = segmentLines('Installation and commissioning $42,000\nOption: spare kit $1,200');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.line_role).toBe('base');
    expect(lines[0]!.extended_minor).toBe(4_200_000);
    expect(lines[1]!.line_role).toBe('option');
    expect(lines[0]!.char_end).toBeGreaterThan(lines[0]!.char_start);
  });
});

describe('parse_quality (spec 4.1)', () => {
  it('scores a rich priced offer above the floor and a sparse note below it', () => {
    const rich = segmentLines('Installation and commissioning of the line. $42,000\nTraining, two sessions. $2,400');
    const richQ = computeParseQuality({ chars: 90, pages: 1, lines: rich, imageOnly: false });
    expect(richQ).toBeGreaterThan(0.35);

    const sparse = segmentLines('see attached');
    const sparseQ = computeParseQuality({ chars: 12, pages: 1, lines: sparse, imageOnly: false });
    expect(sparseQ).toBeLessThan(0.35);
  });

  it('is 0 for an image-only read', () => {
    expect(computeParseQuality({ chars: 0, pages: 1, lines: [], imageOnly: true })).toBe(0);
  });
});

describe('malicious-document ceilings (spec 5.4)', () => {
  it('rejects an oversize document with the 20MB message, before decompression', () => {
    expect(() => assertDocCeilings({ byteLen: DEFAULT_DOC_LIMITS.maxDocBytes + 1 })).toThrowError(DocCeilingError);
    try {
      assertDocCeilings({ byteLen: DEFAULT_DOC_LIMITS.maxDocBytes + 1 });
    } catch (e) {
      expect((e as DocCeilingError).reason).toBe('oversize_document');
      expect((e as Error).message).toBe('this file is larger than 20MB');
    }
  });

  it('rejects a zip-bomb by uncompressed size BEFORE decompression', () => {
    // Small on-disk bytes, huge declared uncompressed size: refused from the header alone.
    expect(() =>
      assertDocCeilings({ byteLen: 1024, uncompressedBytes: DEFAULT_DOC_LIMITS.maxUncompressedBytes + 1 }),
    ).toThrowError(/uncompressed size/);
  });

  it('rejects an over-count archive by entry count BEFORE decompression', () => {
    expect(() =>
      assertDocCeilings({ byteLen: 1024, entryCount: DEFAULT_DOC_LIMITS.maxEntryCount + 1 }),
    ).toThrowError(/entry count/);
  });

  it('pins content-type: a PDF declared csv, and a ZIP declared csv, are rejected', () => {
    expect(detectMagicFormat(pdfWithTextLayer())).toBe('pdf');
    expect(detectMagicFormat(zipMagicBuffer())).toBe('zip');
    expect(() => pinContentType(pdfWithTextLayer(), 'csv')).toThrowError(DocCeilingError);
    expect(() => pinContentType(zipMagicBuffer(), 'csv')).toThrowError(DocCeilingError);
    // A genuine PDF declared pdf, and plain text declared csv, pass.
    expect(() => pinContentType(pdfWithTextLayer(), 'pdf')).not.toThrow();
    expect(() => pinContentType(Buffer.from('item,price\n', 'utf8'), 'csv')).not.toThrow();
  });
});

describe('lexicon pre-pass (spec 4.2 / 5.3)', () => {
  it('marks blanket-claim and exclusion lines in place', () => {
    const lines = segmentLines(
      'This is an all-inclusive turnkey price. $50,000\nInstallation excluded; by others. $0\nTraining $2,400',
    );
    const counts = applyLexicons(lines, DEFAULT_BLANKET_FALLBACK, [
      'excluded',
      'by others',
    ]);
    expect(counts.blanketLines).toBe(1);
    expect(lines[0]!.blanket_claim).toBe(true);
    expect(counts.exclusionLines).toBe(1);
    expect(lines[1]!.exclusion_hit).toBe(true);
    expect(lines[2]!.blanket_claim).toBe(false);
  });
});
