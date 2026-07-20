import { LlmThrottledError, LlmError } from '../../lib/llm-errors.js';
import {
  chunkText,
  chunkCharRange,
  computeScopeDedupKey,
  verifyCiteAgainstChunkLine,
  parseChunkNodes,
  finalizeOutcome,
  type RawScopeNode,
} from './derivation-logic.js';

// Re-export the pure helpers so tests can import them without pulling in db/env.
export {
  chunkText,
  chunkCharRange,
  computeScopeDedupKey,
  verifyCiteAgainstChunkLine,
  parseChunkNodes,
  finalizeOutcome,
};

/**
 * The async-start scope-derivation engine (spec 3.2). Each INVOCATION processes AT MOST ONE
 * chunk of the request document, so `POST /internal/run-derivation` returns fast (202 + run id)
 * and the worker polls, one chunk per poll. This is the same fix leveling got: a synchronous
 * handler that times out lets fetch-abort leave the handler running while BullMQ retries and
 * puts a SECOND writer on one `last_processed_chunk`, whose divergent ordinals are precisely
 * what fix (a) exists to prevent.
 *
 * Every checkpoint / node insert / finalize is CLAIM-FENCED: conditioned on
 * `claimed_by = $me AND status = 'running'`, and a zero-row update aborts the slice, so the
 * reaper cannot create the race it was added to fix.
 *
 * Fixes ported from burn's extraction engine (spec 3.2):
 *   (a) chunk-relative dedup ordinal (`derivation-logic.computeScopeDedupKey`).
 *   (b) a dropped chunk is COUNTED as failed and blocks `scope_status` from `derived`
 *       (`chunks_failed` + `finalizeOutcome`), never `log.debug; continue -> succeeded`.
 *   (c) per-chunk-line span verification (`derivation-logic.verifyCiteAgainstChunkLine`).
 */

export const DEFAULT_DERIVATION_LEASE_MS = 5 * 60 * 1000;
const CHUNK_CHARS = 6000;

/** A live lease is held by a different claimant. The route maps this to 409. */
export class LeaseHeldError extends Error {
  constructor(public readonly heldBy: string | null) {
    super('derivation run is claimed by another worker');
    this.name = 'LeaseHeldError';
  }
}

export class DerivationRunNotFoundError extends Error {
  constructor() {
    super('derivation run not found for this org/request');
    this.name = 'DerivationRunNotFoundError';
  }
}

export interface FailedChunk {
  index: number;
  start: number;
  end: number;
}

export interface DerivationRunRow {
  id: string;
  organization_id: string;
  request_id: string;
  status: string;
  chunk_count: number | null;
  last_processed_chunk: number;
  chunks_failed: number;
  nodes_extracted: number;
  low_confidence_count: number;
  claimed_by: string | null;
  heartbeat_at: Date | null;
  failed_chunks: FailedChunk[];
}

export interface ScopeNodeToInsert {
  title: string;
  description: string | null;
  node_kind: string;
  normative_strength: string;
  unit: string | null;
  quantity: number | null;
  cited_span: unknown;
  confidence: number;
  dedup_key: string;
}

export interface DerivationCheckpoint {
  last_processed_chunk: number;
  nodes_extracted: number;
  chunks_failed: number;
  low_confidence_count: number;
  failed_chunks: FailedChunk[];
}

export interface DerivationFinalize {
  runStatus: 'succeeded' | 'partial' | 'blocked' | 'failed';
  scopeStatus: 'derived' | 'pending';
  message: string | null;
}

/**
 * The persistence surface the engine needs. Injected so the M3 unit suite exercises the real
 * slice loop (lease, fencing, fix b) against an in-memory store, no live Postgres required.
 * The production implementation (`makeDbDerivationStore`) wraps every method in `runInOrgScope`.
 */
export interface DerivationStore {
  loadRun(orgId: string, runId: string): Promise<DerivationRunRow | null>;
  /** Claim under the lease. Returns the claimed row, or null if unclaimable (lost the race). */
  claim(
    orgId: string,
    runId: string,
    claimant: string,
    leaseMs: number,
    chunkCount: number,
  ): Promise<DerivationRunRow | null>;
  /** Insert a node idempotently by dedup_key, fenced on the claim. */
  insertNode(orgId: string, runId: string, claimant: string, node: ScopeNodeToInsert): Promise<void>;
  /** Persist the checkpoint, fenced on the claim. Returns false on a zero-row (lost) update. */
  checkpoint(orgId: string, runId: string, claimant: string, cp: DerivationCheckpoint): Promise<boolean>;
  /** Transition run + owning request together, fenced on the claim. Returns false if lost. */
  finalize(
    orgId: string,
    runId: string,
    requestId: string,
    claimant: string,
    outcome: DerivationFinalize,
  ): Promise<boolean>;
  /** On throttle: drop the claim, keep status 'running' so a retry resumes. */
  release(orgId: string, runId: string, claimant: string): Promise<void>;
}

/**
 * The LLM classification surface, injected so unit tests use a recorded/mocked harness and do
 * not require a live LLM. The production implementation calls the internal proxy.
 */
export interface ScopeClassifier {
  classifyChunk(chunk: string, chunkIndex: number): Promise<RawScopeNode[]>;
}

export interface DerivationSliceInput {
  orgId: string;
  requestId: string;
  runId: string;
  claimant: string;
  sourceText: string;
  sourceDocHash: string | null;
  /** null when the org has no LLM provider configured -> the run fails loudly at 'blocked'. */
  providerId: string | null;
}

export interface DerivationSliceResult {
  runId: string;
  status: 'running' | 'succeeded' | 'partial' | 'blocked' | 'failed';
  done: boolean;
  processedChunk: number | null;
  chunkCount: number;
  chunksFailed: number;
  nodesExtracted: number;
}

export interface SliceLogger {
  info: (o: unknown, m?: string) => void;
  warn?: (o: unknown, m?: string) => void;
  debug?: (o: unknown, m?: string) => void;
}

function isTerminal(status: string): boolean {
  return status === 'succeeded' || status === 'partial' || status === 'failed' || status === 'blocked';
}

function isFresh(heartbeat: Date | null, leaseMs: number): boolean {
  if (!heartbeat) return false;
  return Date.now() - heartbeat.getTime() < leaseMs;
}

/**
 * Process at most ONE chunk of the request document. Returns `done: true` once the run has
 * reached a terminal status (the worker stops polling). See the file header for the invariants.
 */
export async function runDerivationSlice(
  input: DerivationSliceInput,
  store: DerivationStore,
  classifier: ScopeClassifier,
  log: SliceLogger,
  opts?: { leaseMs?: number; chunkChars?: number },
): Promise<DerivationSliceResult> {
  const leaseMs = opts?.leaseMs ?? DEFAULT_DERIVATION_LEASE_MS;
  const chunkChars = opts?.chunkChars ?? CHUNK_CHARS;
  const chunks = chunkText(input.sourceText, chunkChars);
  const started = Date.now();

  const run = await store.loadRun(input.orgId, input.runId);
  if (!run || run.request_id !== input.requestId || run.organization_id !== input.orgId) {
    throw new DerivationRunNotFoundError();
  }
  if (isTerminal(run.status)) {
    return {
      runId: run.id,
      status: run.status as DerivationSliceResult['status'],
      done: true,
      processedChunk: null,
      chunkCount: chunks.length,
      chunksFailed: run.chunks_failed,
      nodesExtracted: run.nodes_extracted,
    };
  }
  // Lease: a still-alive DIFFERENT claimant rejects re-entry (409). A stale lease is reclaimable.
  if (run.claimed_by && run.claimed_by !== input.claimant && isFresh(run.heartbeat_at, leaseMs)) {
    throw new LeaseHeldError(run.claimed_by);
  }

  const claimed = await store.claim(input.orgId, input.runId, input.claimant, leaseMs, chunks.length);
  if (!claimed) throw new LeaseHeldError(run.claimed_by);

  // No provider configured: fail loudly (spec 3.4), never silently produce an empty tree.
  if (!input.providerId) {
    const message =
      'No LLM provider is configured for this organization. Set one in Bursar settings before deriving a scope tree.';
    await store.finalize(input.orgId, input.runId, input.requestId, input.claimant, {
      runStatus: 'blocked',
      scopeStatus: 'pending',
      message,
    });
    log.warn?.({ org_id: input.orgId, request_id: input.requestId }, 'bursar derivation: no provider; run blocked');
    return {
      runId: run.id,
      status: 'blocked',
      done: true,
      processedChunk: null,
      chunkCount: chunks.length,
      chunksFailed: claimed.chunks_failed,
      nodesExtracted: claimed.nodes_extracted,
    };
  }

  const startChunk = claimed.last_processed_chunk + 1;
  let chunksFailed = claimed.chunks_failed;
  let nodesExtracted = claimed.nodes_extracted;
  let lowConf = claimed.low_confidence_count;
  const failedChunks: FailedChunk[] = [...claimed.failed_chunks];

  // All chunks already processed on a prior slice -> finalize (fix b decides the outcome).
  if (startChunk >= chunks.length) {
    return finalize(input, store, log, chunks.length, chunksFailed, nodesExtracted, failedChunks, run.id, started);
  }

  const ci = startChunk;
  const chunk = chunks[ci]!;
  const chunkLines = chunk.split('\n');

  let nodes: RawScopeNode[] | null = null;
  try {
    nodes = await classifier.classifyChunk(chunk, ci);
  } catch (err) {
    if (err instanceof LlmThrottledError) {
      // DEFER: drop the claim, keep 'running', re-throw so a retry resumes from this checkpoint.
      await store.release(input.orgId, input.runId, input.claimant);
      log.warn?.({ org_id: input.orgId, request_id: input.requestId, chunk: ci }, 'bursar derivation: throttled; deferring');
      throw err;
    }
    if (err instanceof LlmError) {
      // FIX (b): COUNT the chunk as failed. Do NOT insert nodes for it and do NOT skip it
      // silently. A failed chunk will block scope_status from `derived` at finalize.
      chunksFailed += 1;
      failedChunks.push({ index: ci, ...chunkCharRange(ci, chunkChars) });
      log.warn?.({ org_id: input.orgId, request_id: input.requestId, chunk: ci, err: err.message }, 'bursar derivation: chunk failed to classify (counted, not skipped)');
    } else {
      throw err;
    }
  }

  if (nodes) {
    for (let idx = 0; idx < nodes.length; idx++) {
      const n = nodes[idx]!;
      const verified = verifyCiteAgainstChunkLine(chunkLines, n.cited_line, n.quote);
      const dedupKey = computeScopeDedupKey({
        ref: n.ref,
        title: n.title,
        node_kind: n.node_kind,
        chunkIndex: ci,
        indexWithinChunk: idx,
        source_doc_hash: input.sourceDocHash,
      });
      const confidence = verified ? 0.8 : 0.4;
      if (confidence < 0.6) lowConf += 1;
      await store.insertNode(input.orgId, input.runId, input.claimant, {
        title: n.title,
        description: n.description,
        node_kind: n.node_kind,
        // Precedence table: a request-derived node defaults to `mandatory` (spec 3.2). The
        // model may only carry a weaker strength when it explicitly names one.
        normative_strength: n.normative_strength ?? 'mandatory',
        unit: n.unit,
        quantity: n.quantity,
        cited_span: { quote: n.quote, cited_line: n.cited_line, verified },
        confidence,
        dedup_key: dedupKey,
      });
      nodesExtracted += 1;
    }
  }

  const ok = await store.checkpoint(input.orgId, input.runId, input.claimant, {
    last_processed_chunk: ci,
    nodes_extracted: nodesExtracted,
    chunks_failed: chunksFailed,
    low_confidence_count: lowConf,
    failed_chunks: failedChunks,
  });
  if (!ok) throw new LeaseHeldError(input.claimant); // lost the claim mid-slice -> abort

  const isLast = ci + 1 >= chunks.length;
  if (isLast) {
    return finalize(input, store, log, chunks.length, chunksFailed, nodesExtracted, failedChunks, run.id, started);
  }

  log.info(
    { org_id: input.orgId, request_id: input.requestId, chunk: ci, of: chunks.length, elapsedMs: Date.now() - started },
    'bursar derivation: chunk processed',
  );
  return {
    runId: run.id,
    status: 'running',
    done: false,
    processedChunk: ci,
    chunkCount: chunks.length,
    chunksFailed,
    nodesExtracted,
  };
}

async function finalize(
  input: DerivationSliceInput,
  store: DerivationStore,
  log: SliceLogger,
  chunkCount: number,
  chunksFailed: number,
  nodesExtracted: number,
  failedChunks: FailedChunk[],
  runId: string,
  started: number,
): Promise<DerivationSliceResult> {
  const outcome = finalizeOutcome(chunksFailed, failedChunks);
  const ok = await store.finalize(input.orgId, input.runId, input.requestId, input.claimant, {
    runStatus: outcome.runStatus,
    scopeStatus: outcome.scopeStatus,
    message: outcome.message,
  });
  if (!ok) throw new LeaseHeldError(input.claimant);
  log.info(
    {
      org_id: input.orgId,
      request_id: input.requestId,
      run_status: outcome.runStatus,
      scope_status: outcome.scopeStatus,
      chunks_failed: chunksFailed,
      nodes: nodesExtracted,
      elapsedMs: Date.now() - started,
    },
    'bursar derivation: finalized',
  );
  return {
    runId,
    status: outcome.runStatus,
    done: true,
    processedChunk: null,
    chunkCount,
    chunksFailed,
    nodesExtracted,
  };
}
