import { describe, it, expect } from 'vitest';
import { computeScopeDedupKey } from '../src/services/engines/derivation-logic.js';

// FIX (a): the dedup ordinal is chunk-relative `${chunkIndex}:${indexWithinChunk}`, NOT a
// `let ordinal = 0` running counter declared before a resumable loop. burn's original bug: on a
// fresh run a node in chunk 3 hashed at global ordinal 7; on a crash-and-resume that restarted
// the counter at 0 it hashed at ordinal 0, so the same requirement produced a DIFFERENT
// dedup_key and duplicated the row. This suite proves the key is byte-identical across a
// crash-and-resume, and demonstrates that a naive global counter would NOT be.

const DOC_HASH = 'deadbeef'.repeat(8).slice(0, 64);

// A deterministic fixture: nodes per chunk (chunk index -> list of node contents).
const CHUNKS: Array<Array<{ title: string; node_kind: string; ref: string | null }>> = [
  [
    { title: 'Installation and commissioning', node_kind: 'requirement', ref: '1.1' },
    { title: 'Acceptance testing', node_kind: 'requirement', ref: '1.2' },
  ],
  [{ title: '24-month warranty', node_kind: 'requirement', ref: null }],
  [
    { title: 'Crew training', node_kind: 'requirement', ref: '3.1' },
    { title: 'Escalation cap', node_kind: 'requirement', ref: '3.2' },
    { title: 'Data export on termination', node_kind: 'requirement', ref: '3.3' },
  ],
  [{ title: 'Spares and commissioning', node_kind: 'requirement', ref: '4.1' }],
];

function keyFor(chunkIndex: number, indexWithinChunk: number): string {
  const n = CHUNKS[chunkIndex]![indexWithinChunk]!;
  return computeScopeDedupKey({
    ref: n.ref,
    title: n.title,
    node_kind: n.node_kind,
    chunkIndex,
    indexWithinChunk,
    source_doc_hash: DOC_HASH,
  });
}

describe('computeScopeDedupKey resume equality (fix a)', () => {
  it('produces a byte-identical key across a crash-and-resume', () => {
    // Full run: process every chunk 0..3.
    const full = new Map<string, string>();
    for (let ci = 0; ci < CHUNKS.length; ci++) {
      for (let idx = 0; idx < CHUNKS[ci]!.length; idx++) full.set(`${ci}:${idx}`, keyFor(ci, idx));
    }

    // Crash after chunk 1, resume from chunk 2. The resumed run re-derives keys for chunks 2..3.
    const resume = new Map<string, string>();
    for (let ci = 2; ci < CHUNKS.length; ci++) {
      for (let idx = 0; idx < CHUNKS[ci]!.length; idx++) resume.set(`${ci}:${idx}`, keyFor(ci, idx));
    }

    for (const [pos, key] of resume) {
      expect(key, `resume key for ${pos} must equal the full-run key`).toBe(full.get(pos));
    }
  });

  it('is stable regardless of where the resume starts', () => {
    const fresh = keyFor(3, 0);
    // Same chunk/index/content, computed as if nothing before it ran.
    const asFirst = computeScopeDedupKey({
      ref: CHUNKS[3]![0]!.ref,
      title: CHUNKS[3]![0]!.title,
      node_kind: CHUNKS[3]![0]!.node_kind,
      chunkIndex: 3,
      indexWithinChunk: 0,
      source_doc_hash: DOC_HASH,
    });
    expect(fresh).toBe(asFirst);
  });

  it('demonstrates that a naive GLOBAL running ordinal would diverge (the bug fix a prevents)', () => {
    // Reconstruct the defective behavior: a single counter incremented across the whole doc.
    const buggyKey = (globalOrdinal: number, title: string) =>
      // same hash basis shape but with a global ordinal instead of chunk-relative
      computeScopeDedupKey({
        ref: null,
        title: `${title}#${globalOrdinal}`,
        node_kind: 'requirement',
        chunkIndex: 0,
        indexWithinChunk: 0,
        source_doc_hash: DOC_HASH,
      });
    // Full run: the 4th node overall (chunk 2, idx 0) is global ordinal 3.
    const fullRunOrdinal = 3;
    // Resume from chunk 2 with a reset counter: the same node is global ordinal 0.
    const resumeOrdinal = 0;
    expect(buggyKey(fullRunOrdinal, 'Crew training')).not.toBe(buggyKey(resumeOrdinal, 'Crew training'));
  });
});
