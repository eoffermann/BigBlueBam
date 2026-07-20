// Deterministic offer-parse fixtures (M4). No human labeling: every expected number is derivable
// from the fixture text (the human-labeled corpus is M2.5). Kept small and self-describing.

import type { ParseSettings } from '../../src/services/engines/parse.engine.js';
import { DEFAULT_DOC_LIMITS } from '../../src/services/engines/parse-logic.js';
import type { ScopeNodeRef } from '../../src/services/engines/match-logic.js';

/** Spec-default settings (§4.1 floor 0.35, §4.3 caps 4/0.5/4), lexicons empty so the fallback
 *  blanket lexicon is used and the exclusion lexicon is the module default. */
export function specSettings(overrides?: Partial<ParseSettings>): ParseSettings {
  return {
    parse_quality_floor: 0.35,
    blanket_cumulative_cap: 4,
    evidence_concentration_floor: 0.5,
    blanket_fanout_cap: 4,
    blanket_lexicon: [],
    exclusion_lexicon: [],
    limits: DEFAULT_DOC_LIMITS,
    ...overrides,
  };
}

// ── split-blanket fixture (spec 4.6) ─────────────────────────────────────────
// 14 mandatory nodes; 4 base lines each naming 3-4 of them by title; NO blanket-lexicon token.
// The cumulative cap (4) trips at 14 unsub-priced mandatory nodes, and evidence-concentration
// (4 lines / 14 nodes = 0.29) trips the 0.5 floor. Neither depends on the line count.
export const SPLIT_BLANKET_NODES: ScopeNodeRef[] = [
  'Installation',
  'Commissioning',
  'Training',
  'Warranty',
  'Documentation',
  'Freight',
  'Calibration',
  'Testing',
  'Spares',
  'Signage',
  'Permits',
  'Cleanup',
  'Insurance',
  'Handover',
].map((title, i) => ({ id: `00000000-0000-0000-0000-0000000000${String(i + 10)}`, title, normative_strength: 'mandatory' }));

// Four priced base lines. Together they reference all 14 node titles verbatim, with NO phrase from
// the blanket lexicon (no "all-inclusive", "turnkey", "complete solution", "no exclusions", ...).
export const SPLIT_BLANKET_TEXT = [
  'Site works package: Installation, Commissioning, Training and Warranty. $42,000',
  'Delivery bundle: Documentation, Freight, Calibration, Testing. $18,500',
  'Support lot: Spares, Signage, Permits. $9,750',
  'Closeout scope: Cleanup, Insurance, Handover. $6,200',
].join('\n');

// ── A legitimate small offer (control) ───────────────────────────────────────
export const LEGIT_OFFER_TEXT = [
  'Installation and commissioning of the packaging line. $42,000',
  'On-site operator training, two sessions. $2,400',
  'Warranty coverage, 24 months parts and labor. $1,800',
].join('\n');

export const LEGIT_NODES: ScopeNodeRef[] = [
  { id: '00000000-0000-0000-0000-000000000001', title: 'Installation', normative_strength: 'mandatory' },
  { id: '00000000-0000-0000-0000-000000000002', title: 'Training', normative_strength: 'mandatory' },
  { id: '00000000-0000-0000-0000-000000000003', title: 'Warranty', normative_strength: 'should_have' },
];

// ── A tiny PDF with a text layer (Tj show operators) ─────────────────────────
export function pdfWithTextLayer(): Buffer {
  return Buffer.from(
    '%PDF-1.4\n' +
      '1 0 obj<</Type /Page>>endobj\n' +
      'BT\n' +
      '(Installation and commissioning line item) Tj\n' +
      '(Warranty coverage, 24 months) Tj\n' +
      'ET\n' +
      '%%EOF\n',
    'latin1',
  );
}

/** An image-only scan: a PDF header with NO Tj/TJ text operators (spec 4.1 unparseable). */
export function pdfImageOnly(): Buffer {
  return Buffer.from('%PDF-1.4\n1 0 obj<</Type /Page>>endobj\n%% scanned image, no text layer\n%%EOF\n', 'latin1');
}

export const OFFER_CSV = 'item,qty,price\nInstallation,1,42000\nTraining,2,2400\nWarranty,24,1800\n';

export const OFFER_JSONL =
  '{"item":"Installation","price":42000}\n{"item":"Warranty","price":1800}\n{"item":"Training","price":2400}\n';

/** A ZIP-container magic prefix, to prove content-type pinning rejects a spoofed csv. */
export function zipMagicBuffer(): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('PK payload')]);
}
