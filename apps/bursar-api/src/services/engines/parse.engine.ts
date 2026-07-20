// The deterministic offer-parse orchestrator (spec 4.1, 4.3, 5, M4), a PURE function over document
// bytes. NO db/env import and NO LLM: Stage 1 is entirely deterministic. `parseOfferDocument` runs
// the whole pipeline and returns everything the store persists; the unit suite calls it directly
// with a Buffer fixture, so quarantine, the two counters, parse_quality gating, and the ceilings
// are all provable without a live Postgres or a live worker.

import { scanForInjection, type InjectionScanResult } from '../../lib/injection-prescan.js';
import type { BursarSourceFormat } from '@bigbluebam/shared';
import {
  assertDocCeilings,
  applyLexicons,
  computeParseQuality,
  extractText,
  pinContentType,
  segmentLines,
  DocCeilingError,
  DEFAULT_DOC_LIMITS,
  type DocLimits,
  type ParsedLine,
} from './parse-logic.js';
import {
  computePerOfferCounters,
  evaluateCaps,
  matchLinesToNodes,
  type CapThresholds,
  type LineNodeMatch,
  type PerOfferCounters,
  type ScopeNodeRef,
} from './match-logic.js';

export interface ParseSettings extends CapThresholds {
  parse_quality_floor: number;
  blanket_lexicon: string[];
  exclusion_lexicon: string[];
  limits: DocLimits;
}

export interface ParseInput {
  buf: Buffer;
  declaredFormat: BursarSourceFormat;
  /** Confirmed scope nodes of the offer's request, for structural matching (spec 4.4). */
  nodes: ScopeNodeRef[];
  settings: ParseSettings;
  /** Pre-decode byte length + optional container header stats for the ceilings (spec 5.4). */
  byteLen: number;
  uncompressedBytes?: number | null;
  entryCount?: number | null;
}

export type ParseStatus = 'parsed' | 'unparseable' | 'blocked';

export interface ManipulationFinding {
  suspected: boolean;
  reasons: Array<'blanket_lexicon' | 'cumulative_cap' | 'evidence_concentration' | 'per_line_fanout' | 'injection'>;
  /** Cited spans for the finding: the first blanket line and any injection spans. */
  spans: Array<{ kind: string; ordinal?: number; text: string; start?: number; end?: number }>;
}

export interface ParseOutcome {
  status: ParseStatus;
  /** Set on a `blocked`/`unparseable` outcome so the offer row and UI can explain the refusal. */
  error: string | null;
  parse_quality: number;
  page_count: number;
  image_only: boolean;
  lines: ParsedLine[];
  matches: LineNodeMatch[];
  counters: PerOfferCounters;
  blanket_suspected: boolean;
  injection_suspected: boolean;
  injection_signals: { categories: string[]; spans: InjectionScanResult['spans'] };
  manipulation: ManipulationFinding;
  cap_reasons: string[];
  blanket_lines: number;
  exclusion_lines: number;
}

const EMPTY_COUNTERS: PerOfferCounters = {
  unsubpriced_mandatory_count: 0,
  evidence_concentration: null,
};

function blockedOutcome(error: string): ParseOutcome {
  return {
    status: 'blocked',
    error,
    parse_quality: 0,
    page_count: 0,
    image_only: false,
    lines: [],
    matches: [],
    counters: EMPTY_COUNTERS,
    blanket_suspected: false,
    injection_suspected: false,
    injection_signals: { categories: [], spans: [] },
    manipulation: { suspected: false, reasons: [], spans: [] },
    cap_reasons: [],
    blanket_lines: 0,
    exclusion_lines: 0,
  };
}

/**
 * Run the full deterministic parse. Throws only for a programming error; a malicious-document
 * ceiling or a content-type spoof returns a `blocked` outcome (mapped to a finding + a refusal),
 * an unreadable scan returns `unparseable`, and a low-quality read returns `unparseable` WITHOUT
 * matching (spec 4.1: below the floor, the offer can never produce `absent`).
 */
export function parseOfferDocument(input: ParseInput): ParseOutcome {
  const { buf, declaredFormat, nodes, settings } = input;

  // 1. Malicious-document ceilings + content-type pinning, BEFORE decompression (spec 5.4).
  try {
    assertDocCeilings(
      { byteLen: input.byteLen, uncompressedBytes: input.uncompressedBytes, entryCount: input.entryCount },
      settings.limits,
    );
    pinContentType(buf, declaredFormat);
  } catch (err) {
    if (err instanceof DocCeilingError) return blockedOutcome(err.message);
    throw err;
  }

  // 2. Text extraction (UTF-8 / PDF Tj-TJ / structured codecs).
  const extracted = extractText(buf, declaredFormat);

  // 3. Injection pre-scan on the offer text (spec 5.3), same scanner as the request pre-scan.
  const injection = scanForInjection(extracted.text, settings.blanket_lexicon.length ? settings.blanket_lexicon : undefined);
  const injectionSignals = { categories: injection.categories, spans: injection.spans };

  // 4. An image-only PDF (no text layer) or a raw XLSX is unparseable, never levelled (spec 4.1).
  if (extracted.imageOnly) {
    return {
      status: 'unparseable',
      error: 'no readable text layer (scanned image or unsupported container); not levelled (no OCR in v1)',
      parse_quality: 0,
      page_count: extracted.pages,
      image_only: true,
      lines: [],
      matches: [],
      counters: EMPTY_COUNTERS,
      blanket_suspected: false,
      injection_suspected: injection.suspected,
      injection_signals: injectionSignals,
      manipulation: injectionFinding(injection),
      cap_reasons: [],
      blanket_lines: 0,
      exclusion_lines: 0,
    };
  }

  // 5. Segment + role-classify + lexicon pre-pass.
  const lines = segmentLines(extracted.text, { maxLines: settings.limits.maxLines });
  const { blanketLines, exclusionLines } = applyLexicons(
    lines,
    settings.blanket_lexicon.length ? settings.blanket_lexicon : DEFAULT_BLANKET_FALLBACK,
    settings.exclusion_lexicon,
  );

  // 6. parse_quality gate. Below the floor: unparseable, no matching, no counters, cannot produce
  //    `absent` downstream. "We could not read it" is not evidence of omission (spec 4.1).
  const quality = computeParseQuality({
    chars: extracted.text.length,
    pages: extracted.pages,
    lines,
    imageOnly: false,
  });
  if (quality < settings.parse_quality_floor) {
    return {
      status: 'unparseable',
      error: `parse_quality ${quality} below floor ${settings.parse_quality_floor}; not levelled`,
      parse_quality: quality,
      page_count: extracted.pages,
      image_only: false,
      lines,
      matches: [],
      counters: EMPTY_COUNTERS,
      blanket_suspected: blanketLines > 0,
      injection_suspected: injection.suspected,
      injection_signals: injectionSignals,
      manipulation: mergeFindings(blanketFinding(lines, blanketLines), injectionFinding(injection)),
      cap_reasons: [],
      blanket_lines: blanketLines,
      exclusion_lines: exclusionLines,
    };
  }

  // 7. Structural matching + the two per-offer counters (spec 4.3).
  const matches = matchLinesToNodes(lines, nodes);
  const counters = computePerOfferCounters(matches, nodes);
  const caps = evaluateCaps(counters, matches, settings);

  const blanketSuspected = blanketLines > 0 || caps.tripped;
  const manipulation = mergeFindings(
    blanketFinding(lines, blanketLines),
    capFinding(caps.reasons),
    injectionFinding(injection),
  );

  return {
    status: 'parsed',
    error: null,
    parse_quality: quality,
    page_count: extracted.pages,
    image_only: false,
    lines,
    matches,
    counters,
    blanket_suspected: blanketSuspected,
    injection_suspected: injection.suspected,
    injection_signals: injectionSignals,
    manipulation,
    cap_reasons: caps.reasons,
    blanket_lines: blanketLines,
    exclusion_lines: exclusionLines,
  };
}

// The offer-side blanket lexicon fallback when settings carry none. Same phrases as the shared
// request pre-scan (spec 4.2), duplicated as a constant so a null setting never disables Defense 1.
export const DEFAULT_BLANKET_FALLBACK: string[] = [
  'all requirements',
  'fully included',
  'all-inclusive',
  'turnkey',
  'everything listed',
  'as specified in your rfq',
  'as specified in your rfp',
  'no additional charge',
  'no exclusions',
  'complete solution',
  'comprehensive',
];

function blanketFinding(lines: ParsedLine[], blanketLines: number): ManipulationFinding {
  if (blanketLines === 0) return { suspected: false, reasons: [], spans: [] };
  const first = lines.find((l) => l.blanket_claim);
  return {
    suspected: true,
    reasons: ['blanket_lexicon'],
    spans: first
      ? [{ kind: 'blanket_lexicon', ordinal: first.ordinal, text: first.raw_text, start: first.char_start, end: first.char_end }]
      : [],
  };
}

function capFinding(reasons: Array<'cumulative_cap' | 'evidence_concentration' | 'per_line_fanout'>): ManipulationFinding {
  if (reasons.length === 0) return { suspected: false, reasons: [], spans: [] };
  return { suspected: true, reasons, spans: [] };
}

function injectionFinding(injection: InjectionScanResult): ManipulationFinding {
  if (!injection.suspected) return { suspected: false, reasons: [], spans: [] };
  return {
    suspected: true,
    reasons: ['injection'],
    spans: injection.spans.slice(0, 5).map((s) => ({ kind: s.category, text: s.match, start: s.start, end: s.end })),
  };
}

function mergeFindings(...findings: ManipulationFinding[]): ManipulationFinding {
  const reasons = new Set<ManipulationFinding['reasons'][number]>();
  const spans: ManipulationFinding['spans'] = [];
  let suspected = false;
  for (const f of findings) {
    if (f.suspected) suspected = true;
    for (const r of f.reasons) reasons.add(r);
    spans.push(...f.spans);
  }
  return { suspected, reasons: [...reasons], spans };
}

// ── Bounded parse context (spec 5.4) ─────────────────────────────────────────
/**
 * Run the parse under a wall-clock budget. The deterministic parser is CPU-bound and in-process
 * (there is no worker_thread/child-process precedent in the engine layer, same as the derivation
 * engine), so the memory ceiling is enforced by the byte + line caps in parse-logic rather than an
 * OS RSS limit; a hard child-process memory cap is deferred to v1.1 and recorded here. The
 * wall-clock cap races the synchronous parse against a timer so a pathological input cannot wedge
 * the request path.
 */
export async function withParseBudget<T>(fn: () => T, wallClockMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`parse exceeded ${wallClockMs}ms wall-clock budget`)), wallClockMs);
    try {
      const result = fn();
      clearTimeout(timer);
      resolve(result);
    } catch (err) {
      clearTimeout(timer);
      reject(err as Error);
    }
  });
}

export { DEFAULT_DOC_LIMITS };
