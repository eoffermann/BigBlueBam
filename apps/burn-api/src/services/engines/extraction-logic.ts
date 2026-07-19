import { createHash } from 'node:crypto';

/**
 * Pure extraction helpers (spec 4.1), split out with NO db/env import so the §12.1 unit suite can
 * exercise them directly. extraction.engine.ts re-exports these and adds the DB/LLM orchestration.
 */

/** Split source text into bounded chunks. Deterministic so a retry re-chunks identically. */
export function chunkText(text: string, chunkChars = 6000): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkChars) chunks.push(text.slice(i, i + chunkChars));
  return chunks;
}

/**
 * The identity hash. LLM prose is NEVER in the identity hash (spec 3.1): a sectioned clause hashes
 * `(normalized_clause_ref, kind, ordinal)`; a null-section item hashes `(verified_quote, kind)`
 * tied to the doc hash, so overlapping-chunk re-extraction collapses onto one row.
 */
export function computeDedupKey(input: {
  clause_ref: string | null;
  deliverable_kind: string;
  ordinal: number;
  verified_quote: string | null;
  source_doc_hash: string | null;
}): string {
  const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
  const basis = input.clause_ref
    ? `${norm(input.clause_ref)}|${input.deliverable_kind}|${input.ordinal}`
    : `${norm(input.verified_quote ?? '')}|${input.deliverable_kind}|${input.source_doc_hash ?? ''}`;
  return createHash('sha256').update(basis).digest('hex').slice(0, 64);
}

/**
 * Cite verification (spec 4.1 step 5). A failed match sets verified=false and forces
 * pending_review regardless of confidence: the quote must exist in the bytes.
 */
export function verifyCite(chunk: string, quote: string | null | undefined): boolean {
  if (!quote) return false;
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  return norm(chunk).includes(norm(quote));
}

export interface ExtractedDeliverable {
  title: string;
  clause_ref: string | null;
  deliverable_kind: string;
  quote: string | null;
  stated_price_minor: number | null;
  confidence: number;
}

/** Parse and validate the strict-JSON model output for one chunk; malformed rows are dropped. */
export function parseChunkExtraction(modelText: string): ExtractedDeliverable[] {
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
  const out: ExtractedDeliverable[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    if (typeof r.title !== 'string' || !r.title.trim()) continue;
    const kind = typeof r.deliverable_kind === 'string' ? r.deliverable_kind : 'work_product';
    out.push({
      title: r.title.slice(0, 512),
      clause_ref: typeof r.clause_ref === 'string' ? r.clause_ref.slice(0, 64) : null,
      deliverable_kind: kind,
      quote: typeof r.quote === 'string' ? r.quote : null,
      stated_price_minor: typeof r.stated_price_minor === 'number' ? Math.round(r.stated_price_minor) : null,
      confidence: typeof r.confidence === 'number' && r.confidence >= 0 && r.confidence <= 1 ? r.confidence : 0,
    });
  }
  return out;
}
