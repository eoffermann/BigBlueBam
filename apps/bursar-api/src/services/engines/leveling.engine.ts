// The async-start leveling engine (spec 3.4-3.9, 4, 18.6, M5). Each INVOCATION processes AT MOST
// ONE offer of the request, so `POST /internal/run-leveling` returns fast (202 + run id) and the
// worker polls, one offer per poll. Same fix as derivation: a synchronous handler that times out
// lets fetch-abort leave the handler running while BullMQ retries, putting a SECOND writer on one
// checkpoint. The advisory lock cannot span an LLM run, so the 409 keys off run status backed by
// heartbeat_at + claimed_by, heartbeated on EVERY checkpoint commit.
//
// Every window-result / coverage / checkpoint / finalize write is CLAIM-FENCED: conditioned on
// `claimed_by = $me AND status = 'running'`, and a zero-row update ABORTS the slice immediately, so
// the reaper cannot create the race it was added to fix. Slices of one run execute serially.
//
// The §3.4 failure table is honored here:
//   - LlmThrottledError (429)  -> DEFER: drop the claim, keep 'running', re-throw so a retry
//                                 resumes from the checkpoint. NEVER a default verdict.
//   - LlmError                 -> `ambiguous`, NEVER `absent`.
//   - LlmMalformedError        -> retry at a smaller batch, capped at 2, then `ambiguous`.
//   - a node missing from a batch -> retried individually, then `ambiguous`, never `absent`.
//   - no provider configured   -> the run fails loudly at status='blocked'.

import { LlmThrottledError, LlmError, LlmMalformedError } from '../../lib/llm-errors.js';
import {
  adjudicateOffer,
  type AdjudicationLine,
  type AdjudicationNode,
  type AdjudicationOffer,
  type AdjudicationResult,
  type AdjudicationSettings,
} from './coverage-adjudication.js';
import {
  latticeRank,
  type Verdict,
} from './leveling-logic.js';
import type { AdjudicationAnswer } from './coverage-adjudication.js';
import type {
  ClassifierLine,
  ClassifierNode,
  CoverageClassifier,
  RawCoverageAnswer,
} from './leveling-classifier.js';

// Re-export the pure helpers so tests import them without pulling in db/env.
export { adjudicateOffer } from './coverage-adjudication.js';
export * from './leveling-logic.js';
export { BATCH_NODES, parseCoverageAnswers, makeLlmCoverageClassifier } from './leveling-classifier.js';

export const DEFAULT_LEVELING_LEASE_MS = 5 * 60 * 1000;

export class LevelingLeaseHeldError extends Error {
  constructor(public readonly heldBy: string | null) {
    super('leveling run is claimed by another worker');
    this.name = 'LevelingLeaseHeldError';
  }
}

export class LevelingRunNotFoundError extends Error {
  constructor() {
    super('leveling run not found for this org/request');
    this.name = 'LevelingRunNotFoundError';
  }
}

/* ================================================================== */
/*  Window building (spec 3.8) - pure, exported for tests             */
/* ================================================================== */

export interface EngineLine extends AdjudicationLine {
  ordinal: number;
}

export interface LevelingWindow {
  index: number;
  lines: ClassifierLine[];
}

/**
 * Slide a window over the offer's lines (spec 3.8). Each window is a bounded slice PLUS every
 * pinned (exclusion-lexicon) line, appended regardless of boundary, because a real proposal puts
 * its exclusions in a terminal block hundreds of lines from the priced line and the exclusion and
 * its target are otherwise never in the same window. Deterministic: a resume re-windows identically.
 */
export function buildWindows(
  lines: EngineLine[],
  maxLinesPerWindow: number,
  overlap: number,
): LevelingWindow[] {
  const ordered = [...lines].sort((a, b) => a.ordinal - b.ordinal);
  const toRef = (l: EngineLine): ClassifierLine => ({ offer_line_id: l.offer_line_id, raw_text: l.raw_text });
  const pinned = ordered.filter((l) => l.exclusion_hit);
  if (ordered.length <= maxLinesPerWindow) {
    return [{ index: 0, lines: ordered.map(toRef) }];
  }
  const step = Math.max(1, maxLinesPerWindow - Math.max(0, overlap));
  const windows: LevelingWindow[] = [];
  let index = 0;
  for (let start = 0; start < ordered.length; start += step) {
    const slice = ordered.slice(start, start + maxLinesPerWindow);
    const ids = new Set(slice.map((l) => l.offer_line_id));
    // Pin the exclusion lines into every window that does not already contain them.
    const withPins = [...slice, ...pinned.filter((p) => !ids.has(p.offer_line_id))];
    windows.push({ index, lines: withPins.map(toRef) });
    index += 1;
    if (start + maxLinesPerWindow >= ordered.length) break;
  }
  return windows;
}

/* ================================================================== */
/*  Batch classification with the §3.4 retry table - testable         */
/* ================================================================== */

function ambiguousAnswer(scopeNodeId: string): RawCoverageAnswer {
  return {
    scope_node_id: scopeNodeId,
    verdict: 'ambiguous',
    cited_offer_line_id: null,
    quote: null,
    classifier_confidence: 0,
    rejected_candidates: [],
  };
}

export interface ClassifyRetryOptions {
  /** Malformed-response retry budget. Spec caps this at 2 (spec 3.4). */
  malformedBudget?: number;
}

/**
 * Classify a batch of nodes against one window's lines, applying the §3.4 failure table. Exported
 * and injectable so the unit suite drives it with a mock classifier (malformed-retry-capped-at-2,
 * missing-node -> ambiguous). A throttle re-throws so the slice can DEFER. NEVER returns `absent`
 * on a failure - `absent` is only ever a real, evidence-backed classifier verdict.
 */
export async function classifyBatchWithRetry(
  classifier: CoverageClassifier,
  lines: ClassifierLine[],
  nodes: ClassifierNode[],
  opts: ClassifyRetryOptions = {},
): Promise<Map<string, RawCoverageAnswer>> {
  const malformedBudget = opts.malformedBudget ?? 2;
  if (nodes.length === 0) return new Map();

  let answers: Map<string, RawCoverageAnswer>;
  try {
    answers = await classifier.classifyBatch(lines, nodes);
  } catch (err) {
    if (err instanceof LlmThrottledError) throw err; // DEFER
    if (err instanceof LlmMalformedError) {
      if (malformedBudget > 0 && nodes.length > 1) {
        const mid = Math.ceil(nodes.length / 2);
        const left = await classifyBatchWithRetry(classifier, lines, nodes.slice(0, mid), {
          malformedBudget: malformedBudget - 1,
        });
        const right = await classifyBatchWithRetry(classifier, lines, nodes.slice(mid), {
          malformedBudget: malformedBudget - 1,
        });
        return new Map([...left, ...right]);
      }
      // Retry budget exhausted (or a single node still truncates): ambiguous, never absent.
      return new Map(nodes.map((n) => [n.scope_node_id, ambiguousAnswer(n.scope_node_id)]));
    }
    if (err instanceof LlmError) {
      // A failed decision is ambiguous/pending, NEVER absent (spec 3.4).
      return new Map(nodes.map((n) => [n.scope_node_id, ambiguousAnswer(n.scope_node_id)]));
    }
    throw err;
  }

  // A node missing from the batch response is retried INDIVIDUALLY once, then ambiguous (spec 3.4).
  const result = new Map(answers);
  const missing = nodes.filter((n) => !result.has(n.scope_node_id));
  for (const n of missing) {
    try {
      const single = await classifier.classifyBatch(lines, [n]);
      const a = single.get(n.scope_node_id);
      result.set(n.scope_node_id, a ?? ambiguousAnswer(n.scope_node_id));
    } catch (err) {
      if (err instanceof LlmThrottledError) throw err; // DEFER
      // Any other failure on the individual retry: ambiguous, never absent.
      result.set(n.scope_node_id, ambiguousAnswer(n.scope_node_id));
    }
  }
  return result;
}

/* ================================================================== */
/*  Store surface + slice types                                       */
/* ================================================================== */

export interface LevelingRunRow {
  id: string;
  organization_id: string;
  request_id: string;
  status: string;
  last_processed_offer_index: number;
  offer_count: number | null;
  node_count: number | null;
  llm_calls_used: number;
  coverage_written: number;
  claimed_by: string | null;
  heartbeat_at: Date | null;
  max_llm_calls_per_run: number;
}

export interface OfferForLeveling {
  offer_id: string;
  parse_quality: number | null;
  blanket_suspected: boolean;
  injection_suspected: boolean;
  normalization_status: string | null;
  currency: string;
}

export interface WindowResultToWrite {
  offer_id: string;
  scope_node_id: string;
  window_index: number;
  verdict: Verdict;
  cited_span: unknown;
}

/** A per-window classifier answer, reconstructable from a durable window_results row's cited_span. */
export interface WindowAnswer {
  verdict: Verdict;
  cited_offer_line_id: string | null;
  quote: string | null;
  classifier_confidence: number;
  rejected_candidates: Array<{ offer_line_id: string; reason?: string }>;
  allocation_method?: import('./leveling-logic.js').AllocationMethod | null;
  priced_amount_minor?: number | null;
  human_confirmed?: boolean;
}

export interface LevelingCheckpoint {
  last_processed_offer_index: number;
  llm_calls_used: number;
  coverage_written: number;
}

export interface LevelingStore {
  loadRun(orgId: string, runId: string): Promise<LevelingRunRow | null>;
  claim(orgId: string, runId: string, claimant: string, leaseMs: number): Promise<LevelingRunRow | null>;
  loadOffers(orgId: string, requestId: string): Promise<OfferForLeveling[]>;
  loadNodes(orgId: string, requestId: string): Promise<Array<AdjudicationNode & { quantity: number | null; unit: string | null }>>;
  loadLines(orgId: string, offerId: string): Promise<EngineLine[]>;
  /** Persisted per-window answers for (run, offer), grouped by node, so a resume skips recompute. */
  loadWindowResults(orgId: string, runId: string, offerId: string): Promise<Map<string, WindowAnswer[]>>;
  writeWindowResult(orgId: string, runId: string, claimant: string, r: WindowResultToWrite): Promise<boolean>;
  writeCoverage(
    orgId: string,
    runId: string,
    claimant: string,
    offerId: string,
    result: AdjudicationResult,
  ): Promise<boolean>;
  writeOfferCounters(orgId: string, offerId: string, unsubpriced: number, concentration: number | null): Promise<void>;
  writeTotals(orgId: string, offerId: string): Promise<void>;
  checkpoint(orgId: string, runId: string, claimant: string, cp: LevelingCheckpoint): Promise<boolean>;
  finalize(
    orgId: string,
    runId: string,
    claimant: string,
    status: 'succeeded' | 'partial' | 'blocked' | 'failed',
    error: string | null,
  ): Promise<boolean>;
  release(orgId: string, runId: string, claimant: string): Promise<void>;
}

export interface LevelingSliceInput {
  orgId: string;
  requestId: string;
  runId: string;
  claimant: string;
  providerId: string | null;
  settings: AdjudicationSettings & { max_lines_per_window: number; window_overlap_lines: number };
  parseQualityFloor: number;
}

export interface LevelingSliceResult {
  runId: string;
  status: 'running' | 'succeeded' | 'partial' | 'blocked' | 'failed';
  done: boolean;
  processedOffer: number | null;
  offerCount: number;
  llmCallsUsed: number;
  /** Published mandatory gaps for the offer processed this slice (drives exclusion.detected). */
  publishedGaps: number;
  /** The offer id processed this slice, for the exclusion.detected ref. */
  processedOfferId: string | null;
}

export interface SliceLogger {
  info: (o: unknown, m?: string) => void;
  warn?: (o: unknown, m?: string) => void;
  debug?: (o: unknown, m?: string) => void;
}

function isTerminal(status: string): boolean {
  return status === 'succeeded' || status === 'partial' || status === 'failed' || status === 'blocked' || status === 'rejected_limits';
}
function isFresh(hb: Date | null, leaseMs: number): boolean {
  return hb ? Date.now() - hb.getTime() < leaseMs : false;
}

/**
 * Process AT MOST ONE offer of the request. Returns `done: true` once the run reaches a terminal
 * status. See the file header for the fencing + failure-table invariants.
 */
export async function runLevelingSlice(
  input: LevelingSliceInput,
  store: LevelingStore,
  classifier: CoverageClassifier,
  log: SliceLogger,
  opts?: { leaseMs?: number },
): Promise<LevelingSliceResult> {
  const leaseMs = opts?.leaseMs ?? DEFAULT_LEVELING_LEASE_MS;
  const started = Date.now();

  const run = await store.loadRun(input.orgId, input.runId);
  if (!run || run.request_id !== input.requestId || run.organization_id !== input.orgId) {
    throw new LevelingRunNotFoundError();
  }
  const offers = await store.loadOffers(input.orgId, input.requestId);
  if (isTerminal(run.status)) {
    return terminalResult(run, offers.length);
  }
  if (run.claimed_by && run.claimed_by !== input.claimant && isFresh(run.heartbeat_at, leaseMs)) {
    throw new LevelingLeaseHeldError(run.claimed_by);
  }
  const claimed = await store.claim(input.orgId, input.runId, input.claimant, leaseMs);
  if (!claimed) throw new LevelingLeaseHeldError(run.claimed_by);

  // No provider configured: fail loudly (spec 3.4), never a silent empty leveling.
  if (!input.providerId) {
    await store.finalize(input.orgId, input.runId, input.claimant, 'blocked',
      'No LLM provider is configured for this organization. Set one in Bursar settings before leveling.');
    log.warn?.({ org_id: input.orgId, request_id: input.requestId }, 'bursar leveling: no provider; run blocked');
    return { runId: run.id, status: 'blocked', done: true, processedOffer: null, offerCount: offers.length, llmCallsUsed: claimed.llm_calls_used, publishedGaps: 0, processedOfferId: null };
  }

  const nodes = await store.loadNodes(input.orgId, input.requestId);
  const startOffer = claimed.last_processed_offer_index + 1;
  let llmCalls = claimed.llm_calls_used;
  let coverageWritten = claimed.coverage_written;

  if (startOffer >= offers.length) {
    const ok = await store.finalize(input.orgId, input.runId, input.claimant, 'succeeded', null);
    if (!ok) throw new LevelingLeaseHeldError(input.claimant);
    log.info({ org_id: input.orgId, request_id: input.requestId, offers: offers.length, elapsedMs: Date.now() - started }, 'bursar leveling: finalized succeeded');
    return { runId: run.id, status: 'succeeded', done: true, processedOffer: null, offerCount: offers.length, llmCallsUsed: llmCalls, publishedGaps: 0, processedOfferId: null };
  }

  const oi = startOffer;
  const offer = offers[oi]!;
  const classifierNodes: ClassifierNode[] = nodes.map((n) => ({
    scope_node_id: n.scope_node_id,
    title: n.title,
    description: n.description,
    normative_strength: n.normative_strength,
  }));

  // An unparseable / blocked offer is never classified (spec 4.1). Its mandatory nodes land
  // `unverified` with withheld_reason='unparseable' via writeCoverage on an empty result path.
  const lines = await store.loadLines(input.orgId, offer.offer_id);
  let result: AdjudicationResult;

  if (offer.normalization_status !== 'parsed' || lines.length === 0) {
    result = adjudicateOffer(
      offerMeta(offer, input.parseQualityFloor),
      nodes,
      [],
      new Map(),
      input.settings,
      false, // window incomplete: an unreadable offer cannot produce a publishable absent
    );
  } else {
    const windows = buildWindows(lines, input.settings.max_lines_per_window, input.settings.window_overlap_lines);
    // Skip windows already settled on a prior slice (durable results); classify the rest.
    const existing = await store.loadWindowResults(input.orgId, input.runId, offer.offer_id);
    for (const w of windows) {
      for (let b = 0; b < classifierNodes.length; b += 6) {
        // Mid-flight LLM-call cap: stop cleanly at partial with the "continue" affordance (spec 3.9).
        if (llmCalls >= run.max_llm_calls_per_run) {
          const ok = await store.checkpoint(input.orgId, input.runId, input.claimant, {
            last_processed_offer_index: oi - 1, // do NOT advance past this offer; continue resumes it
            llm_calls_used: llmCalls,
            coverage_written: coverageWritten,
          });
          if (!ok) throw new LevelingLeaseHeldError(input.claimant);
          await store.finalize(input.orgId, input.runId, input.claimant, 'partial',
            `LLM call budget (${run.max_llm_calls_per_run}) reached; levelled ${oi} of ${offers.length}. Continue to resume.`);
          log.info({ org_id: input.orgId, run: run.id, offer: oi, of: offers.length }, 'bursar leveling: call budget reached; partial');
          return { runId: run.id, status: 'partial', done: true, processedOffer: oi, offerCount: offers.length, llmCallsUsed: llmCalls, publishedGaps: 0, processedOfferId: null };
        }
        const batch = classifierNodes.slice(b, b + 6);
        let answers: Map<string, RawCoverageAnswer>;
        try {
          answers = await classifyBatchWithRetry(classifier, w.lines, batch);
        } catch (err) {
          if (err instanceof LlmThrottledError) {
            // DEFER: drop the claim, keep 'running', re-throw so a retry resumes from the checkpoint.
            await store.release(input.orgId, input.runId, input.claimant);
            log.warn?.({ org_id: input.orgId, run: run.id, offer: oi }, 'bursar leveling: throttled; deferring');
            throw err;
          }
          throw err;
        }
        llmCalls += 1;
        for (const node of batch) {
          const a = answers.get(node.scope_node_id);
          if (!a) continue;
          const ok = await store.writeWindowResult(input.orgId, input.runId, input.claimant, {
            offer_id: offer.offer_id,
            scope_node_id: node.scope_node_id,
            window_index: w.index,
            verdict: a.verdict,
            cited_span: {
              cited_offer_line_id: a.cited_offer_line_id,
              quote: a.quote,
              classifier_confidence: a.classifier_confidence,
              rejected_candidates: a.rejected_candidates,
            },
          });
          if (!ok) throw new LevelingLeaseHeldError(input.claimant); // fencing: lost the claim mid-slice
          if (!existing.has(node.scope_node_id)) existing.set(node.scope_node_id, []);
          existing.get(node.scope_node_id)!.push({
            verdict: a.verdict,
            cited_offer_line_id: a.cited_offer_line_id,
            quote: a.quote,
            classifier_confidence: a.classifier_confidence,
            rejected_candidates: a.rejected_candidates,
          });
        }
      }
    }

    // Merge windows per node into one answer set for adjudication. The lattice reads by
    // (offer, node) scoped to the run; the merged verdict + the priced-line answer drive coverage.
    const merged = mergeWindowAnswers(existing, classifierNodes);
    result = adjudicateOffer(offerMeta(offer, input.parseQualityFloor), nodes, lines, merged, input.settings, true);
  }

  const wrote = await store.writeCoverage(input.orgId, input.runId, input.claimant, offer.offer_id, result);
  if (!wrote) throw new LevelingLeaseHeldError(input.claimant);
  coverageWritten += result.decisions.length;
  await store.writeOfferCounters(input.orgId, offer.offer_id, result.unsubpriced_mandatory_count, result.evidence_concentration);
  await store.writeTotals(input.orgId, offer.offer_id);

  const cp = await store.checkpoint(input.orgId, input.runId, input.claimant, {
    last_processed_offer_index: oi,
    llm_calls_used: llmCalls,
    coverage_written: coverageWritten,
  });
  if (!cp) throw new LevelingLeaseHeldError(input.claimant);

  const publishedGaps = result.decisions.filter((d) => d.decision.reviewStatus === 'published' && d.decision.isGap).length;
  const isLast = oi + 1 >= offers.length;
  if (isLast) {
    const ok = await store.finalize(input.orgId, input.runId, input.claimant, 'succeeded', null);
    if (!ok) throw new LevelingLeaseHeldError(input.claimant);
    log.info({ org_id: input.orgId, run: run.id, offers: offers.length, elapsedMs: Date.now() - started }, 'bursar leveling: finalized succeeded');
    return { runId: run.id, status: 'succeeded', done: true, processedOffer: oi, offerCount: offers.length, llmCallsUsed: llmCalls, publishedGaps, processedOfferId: offer.offer_id };
  }

  log.info({ org_id: input.orgId, run: run.id, offer: oi, of: offers.length, elapsedMs: Date.now() - started }, 'bursar leveling: offer processed');
  return { runId: run.id, status: 'running', done: false, processedOffer: oi, offerCount: offers.length, llmCallsUsed: llmCalls, publishedGaps, processedOfferId: offer.offer_id };
}

function terminalResult(run: LevelingRunRow, offerCount: number): LevelingSliceResult {
  return {
    runId: run.id,
    status: run.status as LevelingSliceResult['status'],
    done: true,
    processedOffer: null,
    offerCount,
    llmCallsUsed: run.llm_calls_used,
    publishedGaps: 0,
    processedOfferId: null,
  };
}

function offerMeta(offer: OfferForLeveling, parseQualityFloor: number): AdjudicationOffer {
  return {
    offer_id: offer.offer_id,
    parse_quality: offer.parse_quality,
    parse_quality_floor: parseQualityFloor,
    blanket_suspected: offer.blanket_suspected,
    injection_suspected: offer.injection_suspected,
  };
}

/**
 * Fold the durable per-window answers for each node down to a single answer via the merge lattice
 * (spec 3.8): the highest-ranked verdict wins and CARRIES ITS OWN cited span, so the adjudicator's
 * predicates verify against the line the winning window actually cited. A node with no window
 * result is left out so the adjudicator's `missingAnswer` treats it as `ambiguous`, never `absent`.
 */
export function mergeWindowAnswers(
  windowAnswers: Map<string, WindowAnswer[]>,
  nodes: ClassifierNode[],
): Map<string, AdjudicationAnswer> {
  const out = new Map<string, AdjudicationAnswer>();
  for (const n of nodes) {
    const answers = windowAnswers.get(n.scope_node_id);
    if (!answers || answers.length === 0) continue;
    // Pick the highest-ranked (lowest lattice index) verdict; ties keep the first seen.
    let winner = answers[0]!;
    for (const a of answers) {
      if (latticeRank(a.verdict) < latticeRank(winner.verdict)) winner = a;
    }
    out.set(n.scope_node_id, {
      scope_node_id: n.scope_node_id,
      verdict: winner.verdict,
      cited_offer_line_id: winner.cited_offer_line_id,
      quote: winner.quote,
      classifier_confidence: winner.classifier_confidence,
      rejected_candidates: winner.rejected_candidates,
      allocation_method: winner.allocation_method ?? null,
      priced_amount_minor: winner.priced_amount_minor ?? null,
      human_confirmed: winner.human_confirmed ?? false,
    });
  }
  return out;
}
