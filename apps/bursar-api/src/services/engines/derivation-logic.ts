import { createHash } from 'node:crypto';

/**
 * Pure scope-derivation helpers (spec 3.2), split out with NO db/env import so the M3 unit
 * suite can exercise them directly. `derivation.engine.ts` re-exports these and adds the
 * DB/LLM orchestration, the lease, and the async-start slice loop.
 *
 * This module is where the THREE ported-engine fixes live in testable form:
 *   (a) `computeScopeDedupKey` derives the ordinal from `${chunkIndex}:${indexWithinChunk}`,
 *       never a `let ordinal = 0` running counter, so a crash-and-resume produces a
 *       byte-identical key (`test/dedup-key.resume.test.ts`).
 *   (c) `verifyCiteAgainstChunkLine` verifies a cited span against the ONE chunk line it
 *       claims, never the whole document.
 * Fix (b) - a dropped chunk cannot report success - lives in the engine, because it is a
 * run-status decision, not a pure transform (`finalizeOutcome` below is its pure core).
 */

/** Split source text into bounded, deterministic char chunks so a retry re-chunks identically. */
export function chunkText(text: string, chunkChars = 6000): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkChars) chunks.push(text.slice(i, i + chunkChars));
  return chunks;
}

/** The character span a chunk occupies in the source doc, for the "could not read N sections" surface. */
export function chunkCharRange(chunkIndex: number, chunkChars = 6000): { start: number; end: number } {
  return { start: chunkIndex * chunkChars, end: (chunkIndex + 1) * chunkChars };
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The identity hash for a derived scope node. FIX (a): the ordinal component is
 * chunk-relative - `${chunkIndex}:${indexWithinChunk}` - so it does NOT depend on how many
 * chunks were processed before this one on any given run attempt. burn's original declared a
 * single `let ordinal = 0` before a resumable loop, so a node in chunk 3 hashed at a different
 * ordinal on a fresh run (ordinal 7, say) than on a resume that restarted the counter at 0,
 * duplicating the row. Here a node's key is a function of (which chunk, position within that
 * chunk, its normalized content) alone, and a resume that re-processes chunk 3 collapses onto
 * the same row.
 *
 * A sectioned requirement hashes `(normalized_ref, kind, chunk-ordinal)`; a section-less one
 * hashes `(normalized_title, kind, chunk-ordinal, source_doc_hash)`.
 */
export function computeScopeDedupKey(input: {
  ref: string | null;
  title: string;
  node_kind: string;
  chunkIndex: number;
  indexWithinChunk: number;
  source_doc_hash: string | null;
}): string {
  const ordinal = `${input.chunkIndex}:${input.indexWithinChunk}`;
  const basis = input.ref
    ? `${norm(input.ref)}|${input.node_kind}|${ordinal}`
    : `${norm(input.title)}|${input.node_kind}|${ordinal}|${input.source_doc_hash ?? ''}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 64);
}

/**
 * FIX (c): verify a cited span against the ONE line of THIS chunk it names, not the whole
 * document. An injection line elsewhere in the doc that happens to contain the quote cannot
 * satisfy a citation attributed to a different line. When `citedLine` is out of range the
 * citation is unverifiable (false). When `citedLine` is null we accept a match against any
 * line of this chunk (still chunk-scoped, never document-scoped).
 */
export function verifyCiteAgainstChunkLine(
  chunkLines: string[],
  citedLine: number | null | undefined,
  quote: string | null | undefined,
): boolean {
  if (!quote || !quote.trim()) return false;
  const q = norm(quote);
  if (citedLine === null || citedLine === undefined) {
    return chunkLines.some((line) => norm(line).includes(q));
  }
  if (citedLine < 0 || citedLine >= chunkLines.length) return false;
  return norm(chunkLines[citedLine]!).includes(q);
}

export interface RawScopeNode {
  title: string;
  description: string | null;
  node_kind: string;
  normative_strength: string | null;
  unit: string | null;
  quantity: number | null;
  ref: string | null;
  cited_line: number | null;
  quote: string | null;
}

const ALLOWED_STRENGTH = new Set(['mandatory', 'should_have', 'nice_to_have', 'informational']);

/**
 * Parse and validate the strict-JSON model output for one chunk of the request document.
 * Malformed rows are dropped. The model returns a JSON array of
 * `{title, description, node_kind, normative_strength, unit, quantity, ref, cited_line, quote}`.
 * `quote` MUST be a verbatim substring of the cited line (verified separately by the engine).
 */
export function parseChunkNodes(modelText: string): RawScopeNode[] {
  let arr: unknown;
  try {
    const s = modelText.indexOf('[');
    const e = modelText.lastIndexOf(']');
    if (s < 0 || e <= s) return [];
    arr = JSON.parse(modelText.slice(s, e + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: RawScopeNode[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.title !== 'string' || !r.title.trim()) continue;
    const strengthRaw = typeof r.normative_strength === 'string' ? r.normative_strength : null;
    out.push({
      title: r.title.slice(0, 512),
      description: typeof r.description === 'string' ? r.description.slice(0, 4000) : null,
      node_kind: typeof r.node_kind === 'string' && r.node_kind.trim() ? r.node_kind.slice(0, 32) : 'requirement',
      normative_strength: strengthRaw && ALLOWED_STRENGTH.has(strengthRaw) ? strengthRaw : null,
      unit: typeof r.unit === 'string' ? r.unit.slice(0, 32) : null,
      quantity: typeof r.quantity === 'number' && Number.isFinite(r.quantity) ? r.quantity : null,
      ref: typeof r.ref === 'string' && r.ref.trim() ? r.ref.slice(0, 64) : null,
      cited_line: typeof r.cited_line === 'number' && Number.isInteger(r.cited_line) ? r.cited_line : null,
      quote: typeof r.quote === 'string' ? r.quote.slice(0, 4000) : null,
    });
  }
  return out;
}

export interface DerivationFinalizeOutcome {
  /** The run's terminal status. */
  runStatus: 'succeeded' | 'partial';
  /** The request's scope_status. FIX (b): a run with any failed chunk NEVER reaches `derived`. */
  scopeStatus: 'derived' | 'pending';
  /** Human-facing summary; non-null only when chunks failed. */
  message: string | null;
}

/**
 * FIX (b), pure core: a dropped chunk cannot report success. If ANY chunk failed to classify,
 * the run lands `partial` and the request's `scope_status` is held at `pending` - it must NOT
 * reach `derived`, because a tree missing a chunk would confirm clean on requirements that were
 * never enumerated, invisible to the false-absence gate (the node does not exist). burn's
 * original did `log.debug; continue` on `LlmError` and finished `succeeded`.
 */
export function finalizeOutcome(
  chunksFailed: number,
  failedRanges: Array<{ start: number; end: number }>,
): DerivationFinalizeOutcome {
  if (chunksFailed > 0) {
    const ranges = failedRanges.map((r) => `chars ${r.start}-${r.end}`).join(', ');
    return {
      runStatus: 'partial',
      scopeStatus: 'pending',
      message: `We could not read ${chunksFailed} section${chunksFailed === 1 ? '' : 's'} of the request (${ranges}). The scope tree is incomplete and cannot be marked derived until it is re-derived or those sections are added by hand.`,
    };
  }
  return { runStatus: 'succeeded', scopeStatus: 'derived', message: null };
}
