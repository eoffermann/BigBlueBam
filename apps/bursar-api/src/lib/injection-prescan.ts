// Stage 0 injection pre-scan (spec 5.5), a PURE module with no db/env import so it is unit
// testable and so the request service and the worker can both call it.
//
// The RFQ is the HIGHER-leverage target: it is routinely drafted on an incumbent's template,
// ingested through the same untrusted byte path, and its nodes default to `mandatory`, so
// poisoning it edits the ruler every competitor is measured against. The pre-scan runs on the
// request document; a hit sets `bursar_requests.injection_suspected` + `injection_signals`,
// opens a `request_manipulation_suspected` finding, and BLOCKS `confirmed` until the flagged
// spans are cleared.
//
// v1 signals are ONLY the ones the specified `Tj`/`TJ` parser can actually see (spec 5.2): the
// regex carries no graphics state, so zero-font-size / colour-matched / off-page / metadata
// prose are explicitly deferred to v1.1. The five buildable categories are below.

export type InjectionCategory =
  | 'imperative_directive'
  | 'instruction_override'
  | 'role_token'
  | 'control_run'
  | 'blanket_claim';

export interface InjectionSpan {
  category: InjectionCategory;
  match: string;
  start: number;
  end: number;
}

export interface InjectionScanResult {
  suspected: boolean;
  categories: InjectionCategory[];
  spans: InjectionSpan[];
}

// 1. Imperative second-person directives aimed at a reader-model. "you must mark", "please
//    treat every requirement as", "you should consider all items covered", "rate this offer".
const IMPERATIVE_PATTERNS: RegExp[] = [
  /\b(?:you|your)\b[^.\n]{0,40}\b(?:must|should|shall|are to|need to|are required to|have to|will)\b/gi,
  /\b(?:please|kindly)\b[^.\n]{0,30}\b(?:mark|treat|consider|rate|score|classify|assume|ignore|approve|confirm)\b/gi,
  /\b(?:mark|treat|consider|classify|score|rate)\b[^.\n]{0,30}\b(?:as (?:fully )?(?:covered|complete|compliant|included)|covered|compliant)\b/gi,
];

// 2. Instruction-override markers. "ignore the above", "disregard previous instructions",
//    "new instructions", "system prompt", "do not flag".
const OVERRIDE_PATTERNS: RegExp[] = [
  /\b(?:ignore|disregard|forget|override)\b[^.\n]{0,30}\b(?:above|previous|prior|earlier|preceding|instruction|instructions|rules?|prompt|context)\b/gi,
  /\bnew\s+(?:instruction|instructions|rules?|directive|directives|prompt)\b/gi,
  /\b(?:system|developer)\s+(?:prompt|message|instruction)\b/gi,
  /\bdo\s+not\s+(?:flag|report|mark|note|list|surface|exclude)\b/gi,
];

// 3. Role / chat-template tokens that only appear when text is trying to impersonate a turn.
const ROLE_PATTERNS: RegExp[] = [
  /\bas\s+an?\s+(?:ai|assistant|language\s+model|llm)\b/gi,
  /\byou\s+are\s+(?:an?\s+)?(?:ai|assistant|chatgpt|claude|gpt|language\s+model|llm|reviewer|evaluator)\b/gi,
  /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>/gi,
  /^\s*(?:system|assistant|user)\s*:/gim,
  /#{2,}\s*(?:instruction|system|prompt)/gi,
];

// 5. Blanket-coverage claims (§4.2). Present here too because a blanket claim planted in the
//    RFQ pre-declares every requirement satisfied. Same lexicon as the offer-side pre-pass.
export const BLANKET_LEXICON: string[] = [
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

// 4. Zero-width and bidirectional control runs. A single stray char is noise; a RUN of them is
//    a deliberate attempt to hide or reorder text under the visible glyphs.
//    U+200B-200F, U+202A-202E, U+2060-2064, U+2066-2069, U+FEFF.
const CONTROL_RUN = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]{2,}/g;

function collect(
  text: string,
  patterns: RegExp[],
  category: InjectionCategory,
  spans: InjectionSpan[],
): void {
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const match = m[0];
      spans.push({ category, match: match.slice(0, 200), start: m.index, end: m.index + match.length });
      if (m.index === re.lastIndex) re.lastIndex++; // guard against zero-length loops
    }
  }
}

/**
 * Scan a request document for the five v1 injection signals. Returns every matched span so the
 * finding and the UI can cite exactly what tripped, and the confirm gate can require each span
 * to be cleared. Deterministic and side-effect free.
 */
export function scanForInjection(text: string, blanketLexicon: string[] = BLANKET_LEXICON): InjectionScanResult {
  const spans: InjectionSpan[] = [];
  if (text && text.length > 0) {
    collect(text, IMPERATIVE_PATTERNS, 'imperative_directive', spans);
    collect(text, OVERRIDE_PATTERNS, 'instruction_override', spans);
    collect(text, ROLE_PATTERNS, 'role_token', spans);

    CONTROL_RUN.lastIndex = 0;
    let c: RegExpExecArray | null;
    while ((c = CONTROL_RUN.exec(text)) !== null) {
      spans.push({ category: 'control_run', match: '[control-run]', start: c.index, end: c.index + c[0].length });
    }

    const lower = text.toLowerCase();
    for (const phrase of blanketLexicon) {
      const needle = phrase.toLowerCase();
      let from = 0;
      let idx = lower.indexOf(needle, from);
      while (idx !== -1) {
        spans.push({ category: 'blanket_claim', match: phrase, start: idx, end: idx + needle.length });
        from = idx + needle.length;
        idx = lower.indexOf(needle, from);
      }
    }
  }

  spans.sort((a, b) => a.start - b.start);
  const categories = [...new Set(spans.map((s) => s.category))];
  return { suspected: spans.length > 0, categories, spans };
}
