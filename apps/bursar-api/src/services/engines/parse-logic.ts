// Deterministic offer-parse primitives (spec 4.1, 5.4, 6.1, M4), a PURE module with no db/env
// import so the unit suite exercises every stage against fixtures without booting the service.
// Stage 1 is entirely deterministic: NO LLM. The LLM classification is M5.
//
// Pipeline: bytes -> format detect + content-type pinning + malicious-doc ceilings -> text
// extraction (UTF-8 / PDF Tj-TJ show operators / structured codecs) -> line segmentation with
// role classification -> parse_quality -> blanket/exclusion lexicon pre-pass. Everything here is
// side-effect free; persistence and the LLM boundary live elsewhere.

import { decode } from '@bigbluebam/structured-data';
import type { BursarLineRole, BursarSourceFormat } from '@bigbluebam/shared';

export const RAW_TEXT_MAX = 4000;

// ── Malicious-document ceilings (spec 5.4) ───────────────────────────────────
// Checked BEFORE any decompression / codec parse. A structured file declares its uncompressed
// size and entry count in its container header; we refuse oversize/over-count inputs before we
// allocate the decoded form, so a zip-bomb-shaped input cannot exhaust memory during parse.
export interface DocLimits {
  maxDocBytes: number;
  maxUncompressedBytes: number;
  maxEntryCount: number;
  /** Wall-clock budget for one parse; the orchestrator races the parse against it. */
  parseWallClockMs: number;
  /** Hard cap on emitted lines, so an adversarial line count cannot blow up the row set. */
  maxLines: number;
}

export const DEFAULT_DOC_LIMITS: DocLimits = {
  maxDocBytes: 20 * 1024 * 1024,
  maxUncompressedBytes: 64 * 1024 * 1024,
  maxEntryCount: 10_000,
  parseWallClockMs: 20_000,
  maxLines: 20_000,
};

export type CeilingReason =
  | 'oversize_document'
  | 'oversize_uncompressed'
  | 'too_many_entries'
  | 'content_type_mismatch';

export class DocCeilingError extends Error {
  constructor(
    public readonly reason: CeilingReason,
    message: string,
  ) {
    super(message);
    this.name = 'DocCeilingError';
  }
}

/**
 * Enforce the size/entry ceilings BEFORE decompression (spec 5.4). `uncompressedBytes` and
 * `entryCount` are read from a structured container's header when available (both optional so a
 * plain document only pays the byte check). Throws DocCeilingError, which the route maps to a 413
 * with "this file is larger than 20MB" for the byte case.
 */
export function assertDocCeilings(
  meta: { byteLen: number; uncompressedBytes?: number | null; entryCount?: number | null },
  limits: DocLimits = DEFAULT_DOC_LIMITS,
): void {
  if (meta.byteLen > limits.maxDocBytes) {
    throw new DocCeilingError('oversize_document', 'this file is larger than 20MB');
  }
  if (meta.uncompressedBytes != null && meta.uncompressedBytes > limits.maxUncompressedBytes) {
    throw new DocCeilingError(
      'oversize_uncompressed',
      `uncompressed size ${meta.uncompressedBytes} exceeds the ${limits.maxUncompressedBytes}-byte ceiling`,
    );
  }
  if (meta.entryCount != null && meta.entryCount > limits.maxEntryCount) {
    throw new DocCeilingError(
      'too_many_entries',
      `entry count ${meta.entryCount} exceeds the ${limits.maxEntryCount}-entry ceiling`,
    );
  }
}

// ── Format detection + content-type pinning (spec 5.4) ───────────────────────
const PDF_MAGIC = '%PDF-';
// XLSX/ODS/DOCX are ZIP containers ("PK\x03\x04"). We do NOT extract them in v1; a ZIP magic on a
// file declared as a text codec is a mismatch, and a ZIP declared `xlsx` is unparseable (no OCR /
// no zip extraction), not silently levelled.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/** The structured text codecs handled by @bigbluebam/structured-data. */
const STRUCTURED_FORMATS = new Set<BursarSourceFormat>(['csv', 'tsv', 'jsonl', 'json', 'yaml']);

export function isStructuredFormat(f: BursarSourceFormat): boolean {
  return STRUCTURED_FORMATS.has(f);
}

/**
 * Detect the on-disk format from the first bytes, independent of the declared format. Used for
 * content-type pinning: if `detectFormat` disagrees with the declared format in a way that
 * indicates a spoofed container, the caller rejects.
 */
export function detectMagicFormat(buf: Buffer): 'pdf' | 'zip' | 'text' {
  if (buf.subarray(0, 5).toString('latin1') === PDF_MAGIC) return 'pdf';
  if (buf.subarray(0, 4).equals(ZIP_MAGIC)) return 'zip';
  return 'text';
}

/**
 * Content-type pinning (spec 5.4). The declared `source_format` must be consistent with the
 * detected magic bytes. A PDF magic on a text/structured declaration, or a text/PDF declaration
 * on a ZIP container, is a mismatch. A `pdf` declaration with PDF magic is fine; any text codec
 * with no binary magic is fine. Throws DocCeilingError('content_type_mismatch') on a spoof.
 */
export function pinContentType(buf: Buffer, declared: BursarSourceFormat): void {
  const magic = detectMagicFormat(buf);
  if (magic === 'pdf' && declared !== 'pdf') {
    throw new DocCeilingError(
      'content_type_mismatch',
      `declared '${declared}' but the bytes are a PDF`,
    );
  }
  if (magic === 'zip' && declared !== 'xlsx') {
    throw new DocCeilingError(
      'content_type_mismatch',
      `declared '${declared}' but the bytes are a ZIP container`,
    );
  }
  if (declared === 'pdf' && magic !== 'pdf') {
    throw new DocCeilingError('content_type_mismatch', "declared 'pdf' but no %PDF- header found");
  }
}

// ── Text extraction ──────────────────────────────────────────────────────────

export interface ExtractedText {
  text: string;
  /** Page count for parse_quality density. PDFs count real page markers; text is one page. */
  pages: number;
  /** True when a PDF carried no text layer (scanned image): unparseable, never levelled. */
  imageOnly: boolean;
  /** For structured inputs, the number of records the codec yielded. */
  recordCount: number | null;
}

// PDF text-layer extraction from parenthesized show-operator strings (Tj/TJ), ported from
// burn-extract-deliverables.job.ts:30-43. Carries NO graphics state (spec 5.2). An image-only
// scan yields ~empty text -> the offer is `unparseable`, never levelled (no OCR in v1).
export function extractPdfText(buf: Buffer): { text: string; pages: number } {
  const latin = buf.toString('latin1');
  const out: string[] = [];
  const re = /\(((?:\\.|[^\\()])*)\)\s*T[jJ]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin)) !== null) {
    const s = (m[1] ?? '')
      .replace(/\\([()\\])/g, '$1')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t');
    if (s.trim()) out.push(s);
  }
  // Count page objects for the density denominator; at least 1.
  const pageMatches = latin.match(/\/Type\s*\/Page[^s]/g);
  const pages = Math.max(1, pageMatches ? pageMatches.length : 1);
  return { text: out.join('\n'), pages };
}

// Turn a structured record set into offer text lines: one line per record, "key: value" joined,
// so the downstream segmentation + matching see the same shape as a text quote. Uses the shared
// @bigbluebam/structured-data codecs (spec 6.1 / M4).
function extractStructuredText(text: string, format: 'csv' | 'tsv' | 'jsonl' | 'json' | 'yaml'): {
  text: string;
  recordCount: number;
} {
  const result = decode(text, format);
  const data = result.data;
  const records: unknown[] = Array.isArray(data) ? data : [data];
  const lines = records.map((rec) => {
    if (rec !== null && typeof rec === 'object' && !Array.isArray(rec)) {
      return Object.entries(rec as Record<string, unknown>)
        .map(([k, v]) => `${k}: ${stringifyCell(v)}`)
        .join('  ');
    }
    return stringifyCell(rec);
  });
  return { text: lines.join('\n'), recordCount: records.length };
}

function stringifyCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/**
 * Extract normalized text from raw document bytes for a declared format. PDFs use the Tj/TJ path;
 * structured formats use the shared codecs; text/email decode UTF-8. An image-only PDF is flagged
 * `imageOnly` (unparseable). A structured decode failure falls back to raw UTF-8 lines so a
 * malformed CSV is still readable rather than lost.
 */
export function extractText(buf: Buffer, format: BursarSourceFormat): ExtractedText {
  if (format === 'pdf') {
    const { text, pages } = extractPdfText(buf);
    return { text, pages, imageOnly: text.trim().length === 0, recordCount: null };
  }
  if (format === 'xlsx') {
    // Raw .xlsx (a ZIP container) is not extracted in v1 (no zip extraction / no OCR); the caller
    // exports to CSV first. Treat as image-only-equivalent: unparseable, never levelled.
    return { text: '', pages: 1, imageOnly: true, recordCount: null };
  }
  if (isStructuredFormat(format)) {
    const raw = buf.toString('utf8');
    try {
      const { text, recordCount } = extractStructuredText(
        raw,
        format as 'csv' | 'tsv' | 'jsonl' | 'json' | 'yaml',
      );
      return { text, pages: 1, imageOnly: false, recordCount };
    } catch {
      return { text: raw, pages: 1, imageOnly: false, recordCount: null };
    }
  }
  // text / email
  return { text: buf.toString('utf8'), pages: 1, imageOnly: false, recordCount: null };
}

// ── Line segmentation + role classification (spec 6.1 / 4.4) ─────────────────

export interface ParsedLine {
  ordinal: number;
  raw_text: string;
  char_start: number;
  char_end: number;
  page: number;
  quantity: number | null;
  unit: string | null;
  unit_price_minor: number | null;
  extended_minor: number | null;
  currency: string | null;
  line_role: BursarLineRole;
  blanket_claim: boolean;
  exclusion_hit: boolean;
}

const OPTION_RE = /\b(option(?:al)?|add[-\s]?on|upgrade|adder)\b/i;
const ALTERNATE_RE = /\b(alternate|alt\.?|in lieu of|substitute|substitution)\b/i;
const ALLOWANCE_RE = /\ballowance\b/i;
const NOTE_RE = /^\s*(note|notes|terms|assumptions?|clarifications?)\b\s*:?/i;

// A priced line carries a currency-shaped amount and/or a quantity. Only used to distinguish a
// `note` (unpriced prose) from a `base` line and to feed parse_quality.
const CURRENCY_RE = /(?:[$€£]\s?|\bUSD\s?|\bEUR\s?|\bGBP\s?)\d[\d,]*(?:\.\d{2})?/;
const QUANTITY_RE = /\b\d+(?:\.\d+)?\s*(?:x|ea|each|units?|hrs?|hours?|days?|months?|yrs?|years?|pcs?|lots?|sets?|sessions?)\b/i;
const AMOUNT_CAPTURE = /(?:[$€£]\s?|\bUSD\s?|\bEUR\s?|\bGBP\s?)(\d[\d,]*(?:\.\d{1,2})?)/;

export function classifyLineRole(text: string, priced: boolean): BursarLineRole {
  if (NOTE_RE.test(text)) return 'note';
  if (ALLOWANCE_RE.test(text)) return 'allowance';
  if (ALTERNATE_RE.test(text)) return 'alternate';
  if (OPTION_RE.test(text)) return 'option';
  // Unpriced, non-enumerated prose with no quantity reads as a note rather than a base line.
  if (!priced && text.trim().length < 3) return 'note';
  return 'base';
}

/** Parse a money-with-optional-cents string into minor units (cents). Returns null on no match. */
export function parseAmountMinor(text: string): number | null {
  const m = text.match(AMOUNT_CAPTURE);
  if (!m) return null;
  const digits = (m[1] ?? '').replace(/,/g, '');
  if (!digits) return null;
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

/** Parse a leading quantity + unit, e.g. "3 sessions", "24 months". */
export function parseQuantityUnit(text: string): { quantity: number | null; unit: string | null } {
  const m = text.match(/\b(\d+(?:\.\d+)?)\s*(x|ea|each|units?|hrs?|hours?|days?|months?|yrs?|years?|pcs?|lots?|sets?|sessions?)\b/i);
  if (!m) return { quantity: null, unit: null };
  return { quantity: Number(m[1]), unit: (m[2] ?? '').toLowerCase() };
}

/**
 * Segment extracted text into typed offer lines. Deterministic: split on newlines, drop empties,
 * classify a role, parse a price/quantity, and stamp char offsets against the SOURCE TEXT so a
 * later citation verifies against the exact span. Bounded by `maxLines`.
 */
export function segmentLines(text: string, opts?: { maxLines?: number }): ParsedLine[] {
  const maxLines = opts?.maxLines ?? DEFAULT_DOC_LIMITS.maxLines;
  const lines: ParsedLine[] = [];
  let cursor = 0;
  let ordinal = 0;
  for (const rawLine of text.split('\n')) {
    const start = cursor;
    cursor += rawLine.length + 1; // + the consumed '\n'
    const trimmed = rawLine.trim();
    if (trimmed.length === 0) continue;
    if (ordinal >= maxLines) break;
    const bounded = trimmed.slice(0, RAW_TEXT_MAX);
    const priced = CURRENCY_RE.test(trimmed);
    const role = classifyLineRole(trimmed, priced || QUANTITY_RE.test(trimmed));
    const amount = parseAmountMinor(trimmed);
    const { quantity, unit } = parseQuantityUnit(trimmed);
    const leadStart = start + rawLine.indexOf(trimmed);
    lines.push({
      ordinal,
      raw_text: bounded,
      char_start: leadStart,
      char_end: leadStart + trimmed.length,
      page: 1,
      quantity,
      unit,
      unit_price_minor: null,
      extended_minor: amount,
      currency: amount != null ? 'USD' : null,
      line_role: role,
      blanket_claim: false,
      exclusion_hit: false,
    });
    ordinal += 1;
  }
  return lines;
}

// ── parse_quality (spec 4.1) ─────────────────────────────────────────────────
// 0.0 to 1.0 from three deterministic signals: extracted characters per page (density), the
// structured-line ratio (lines that segment into content), and currency/quantity token presence.
// Below `parse_quality_floor` the offer is `unparseable` and can NEVER produce `absent`.
export interface ParseQualityInput {
  chars: number;
  pages: number;
  lines: ParsedLine[];
  imageOnly: boolean;
}

export function computeParseQuality(input: ParseQualityInput): number {
  if (input.imageOnly || input.chars === 0) return 0;
  const pages = Math.max(1, input.pages);
  // (a) character density per page, saturating at ~1000 chars/page.
  const density = Math.min(1, input.chars / pages / 1000);
  // (b) structured-line ratio: content lines relative to a small floor so a one-line offer is not
  // penalized to zero.
  const lineRatio = Math.min(1, input.lines.length / Math.max(4, input.lines.length));
  // (c) financial-token presence across the lines.
  const withMoney = input.lines.filter((l) => l.extended_minor != null || l.unit_price_minor != null).length;
  const withQty = input.lines.filter((l) => l.quantity != null).length;
  const tokenScore = input.lines.length === 0 ? 0 : Math.min(1, (withMoney + withQty) / input.lines.length + 0.3);
  const quality = 0.45 * density + 0.2 * lineRatio + 0.35 * tokenScore;
  return Math.max(0, Math.min(1, Number(quality.toFixed(4))));
}

// ── Blanket-claim + exclusion lexicon pre-pass (spec 4.2 / 5.3) ──────────────
// The blanket lexicon is shared with the request-side pre-scan (BLANKET_LEXICON in
// injection-prescan.ts). The exclusion lexicon is Bursar's own; a hit sets exclusion_hit so §5's
// exclusion pinning (M5) can pull the line into every window.
export const EXCLUSION_LEXICON: string[] = [
  'excluded',
  'excludes',
  'excluding',
  'exclusion',
  'exclusions',
  'not included',
  'does not include',
  'not in scope',
  'out of scope',
  'by others',
  'by owner',
  'at extra cost',
  'additional cost',
  'not provided',
];

function containsAny(haystackLower: string, lexicon: string[]): boolean {
  for (const phrase of lexicon) {
    if (haystackLower.includes(phrase.toLowerCase())) return true;
  }
  return false;
}

/**
 * Mark each line's blanket_claim / exclusion_hit in place from the two lexicons. Returns the count
 * of blanket lines so the caller can raise the quarantine finding (spec 5.3). Pure over the given
 * lexicons (settings may override the defaults).
 */
export function applyLexicons(
  lines: ParsedLine[],
  blanketLexicon: string[],
  exclusionLexicon: string[],
): { blanketLines: number; exclusionLines: number } {
  let blanketLines = 0;
  let exclusionLines = 0;
  for (const line of lines) {
    const lower = line.raw_text.toLowerCase();
    if (containsAny(lower, blanketLexicon)) {
      line.blanket_claim = true;
      blanketLines += 1;
    }
    if (containsAny(lower, exclusionLexicon)) {
      line.exclusion_hit = true;
      exclusionLines += 1;
    }
  }
  return { blanketLines, exclusionLines };
}
