import { describe, it, expect } from 'vitest';
import { verifyCiteAgainstChunkLine } from '../src/services/engines/derivation-logic.js';

// FIX (c): span verification is PER-CHUNK-LINE, not whole-document. A quote must match the
// specific line the node cites (or, when no line is named, some line of THIS chunk) - never text
// that merely appears elsewhere in the document. This defeats instruction-shaped injection that
// plants a matching phrase in a different line/section.

const CHUNK = [
  '1.1 Installation and commissioning of the unit',
  '1.2 Acceptance testing per the attached protocol',
  '1.3 A 24-month warranty on parts and labour',
];

describe('verifyCiteAgainstChunkLine (fix c)', () => {
  it('verifies a quote against the exact cited line', () => {
    expect(verifyCiteAgainstChunkLine(CHUNK, 0, 'Installation and commissioning')).toBe(true);
    expect(verifyCiteAgainstChunkLine(CHUNK, 2, '24-month warranty')).toBe(true);
  });

  it('rejects a quote that lives on a DIFFERENT line than the one cited', () => {
    // The phrase exists in the chunk, but not on the line the node claims (line 0).
    expect(verifyCiteAgainstChunkLine(CHUNK, 0, '24-month warranty')).toBe(false);
  });

  it('rejects a citation to an out-of-range line (unverifiable, not document-wide)', () => {
    expect(verifyCiteAgainstChunkLine(CHUNK, 9, 'Acceptance testing')).toBe(false);
  });

  it('with no line index, matches any line of THIS chunk only', () => {
    expect(verifyCiteAgainstChunkLine(CHUNK, null, 'Acceptance testing')).toBe(true);
    expect(verifyCiteAgainstChunkLine(CHUNK, null, 'crew training')).toBe(false);
  });

  it('is whitespace/case tolerant but content-strict', () => {
    expect(verifyCiteAgainstChunkLine(CHUNK, 1, '  acceptance   TESTING ')).toBe(true);
    expect(verifyCiteAgainstChunkLine(CHUNK, 1, '')).toBe(false);
    expect(verifyCiteAgainstChunkLine(CHUNK, 1, null)).toBe(false);
  });
});
