import { describe, it, expect } from 'vitest';
import {
  runDerivationSlice,
  LeaseHeldError,
  DEFAULT_DERIVATION_LEASE_MS,
  type DerivationStore,
  type DerivationRunRow,
  type ScopeClassifier,
  type ScopeNodeToInsert,
  type DerivationCheckpoint,
  type DerivationFinalize,
} from '../src/services/engines/derivation.engine.js';
import { LlmError, LlmThrottledError } from '../src/lib/llm-errors.js';

// The M3 engine invariants, exercised with an IN-MEMORY store + a mocked classifier (no live DB
// or LLM). Fix (b): a dropped chunk is COUNTED as failed, the run lands `partial`, and
// scope_status is BLOCKED from `derived`. Plus: a 14-node tree derives cleanly; a throttle defers
// and a resume completes; a live different claimant is rejected (409 / LeaseHeldError).

const ORG = 'org-1';
const REQ = 'req-1';
const RUN = 'run-1';

interface MemRun extends DerivationRunRow {}

class MemStore implements DerivationStore {
  run: MemRun;
  scopeStatus = 'deriving';
  nodes = new Map<string, ScopeNodeToInsert>();
  finalized: DerivationFinalize | null = null;

  constructor() {
    this.run = {
      id: RUN,
      organization_id: ORG,
      request_id: REQ,
      status: 'running',
      chunk_count: null,
      last_processed_chunk: -1,
      chunks_failed: 0,
      nodes_extracted: 0,
      low_confidence_count: 0,
      claimed_by: null,
      heartbeat_at: null,
      failed_chunks: [],
    };
  }

  private fresh(leaseMs: number): boolean {
    return !!this.run.heartbeat_at && Date.now() - this.run.heartbeat_at.getTime() < leaseMs;
  }

  async loadRun(orgId: string, runId: string): Promise<DerivationRunRow | null> {
    if (orgId !== ORG || runId !== RUN) return null;
    return { ...this.run, failed_chunks: [...this.run.failed_chunks] };
  }

  async claim(orgId: string, runId: string, claimant: string, leaseMs: number, chunkCount: number) {
    if (orgId !== ORG || runId !== RUN || this.run.status !== 'running') return null;
    const claimable = this.run.claimed_by === null || this.run.claimed_by === claimant || !this.fresh(leaseMs);
    if (!claimable) return null;
    this.run.claimed_by = claimant;
    this.run.heartbeat_at = new Date();
    if (this.run.chunk_count === null) this.run.chunk_count = chunkCount;
    return { ...this.run, failed_chunks: [...this.run.failed_chunks] };
  }

  async insertNode(orgId: string, runId: string, claimant: string, node: ScopeNodeToInsert) {
    if (this.run.claimed_by !== claimant || this.run.status !== 'running') return;
    this.nodes.set(node.dedup_key, node);
  }

  async checkpoint(orgId: string, runId: string, claimant: string, cp: DerivationCheckpoint) {
    if (this.run.claimed_by !== claimant || this.run.status !== 'running') return false;
    this.run.last_processed_chunk = cp.last_processed_chunk;
    this.run.nodes_extracted = cp.nodes_extracted;
    this.run.chunks_failed = cp.chunks_failed;
    this.run.low_confidence_count = cp.low_confidence_count;
    this.run.failed_chunks = [...cp.failed_chunks];
    this.run.heartbeat_at = new Date();
    return true;
  }

  async finalize(orgId: string, runId: string, requestId: string, claimant: string, outcome: DerivationFinalize) {
    if (this.run.claimed_by !== claimant || this.run.status !== 'running') return false;
    this.run.status = outcome.runStatus;
    this.run.claimed_by = null;
    this.finalized = outcome;
    if (this.scopeStatus === 'deriving') this.scopeStatus = outcome.scopeStatus;
    return true;
  }

  async release(orgId: string, runId: string, claimant: string) {
    if (this.run.claimed_by === claimant) this.run.claimed_by = null;
  }
}

const log = { info: () => {}, warn: () => {}, debug: () => {} };

/** A classifier that returns `perChunk[ci]` nodes, or throws what `throwOn[ci]` specifies. */
function classifier(perChunk: number[], throwOn: Record<number, Error> = {}): ScopeClassifier {
  return {
    async classifyChunk(chunk, ci) {
      if (throwOn[ci]) throw throwOn[ci];
      const n = perChunk[ci] ?? 0;
      return Array.from({ length: n }, (_, idx) => ({
        title: `Requirement c${ci} n${idx}`,
        description: null,
        node_kind: 'requirement',
        normative_strength: null,
        unit: null,
        quantity: null,
        ref: `${ci}.${idx}`,
        cited_line: 0,
        quote: chunk.split('\n')[0] ?? null,
      }));
    },
  };
}

// A source doc split into chunks by a small chunkChars so we control the chunk count.
function docOf(chunkCount: number, chunkChars: number): string {
  // Each chunk is `chunkChars` of a repeated line so `split('\n')[0]` verifies the cite.
  return Array.from({ length: chunkCount }, (_, i) => `line-${i} `.padEnd(chunkChars, 'x')).join('');
}

async function drive(store: MemStore, classifier: ScopeClassifier, sourceText: string, claimant = 'w1', chunkChars = 60) {
  let guard = 0;
  for (;;) {
    const res = await runDerivationSlice(
      { orgId: ORG, requestId: REQ, runId: RUN, claimant, sourceText, sourceDocHash: 'h', providerId: 'prov-1' },
      store,
      classifier,
      log,
      { chunkChars, leaseMs: DEFAULT_DERIVATION_LEASE_MS },
    );
    if (res.done) return res;
    if (++guard > 100) throw new Error('drive did not terminate');
  }
}

describe('derivation engine - fix (b): a dropped chunk cannot report success', () => {
  it('a failed chunk lands the run partial and blocks scope_status from derived', async () => {
    const store = new MemStore();
    const doc = docOf(4, 60);
    // chunk 1 fails to classify (transport error); chunks 0,2,3 return nodes.
    const c = classifier([3, 0, 4, 3], { 1: new LlmError('boom', 500) });
    const res = await drive(store, c, doc);

    expect(res.status).toBe('partial');
    expect(store.scopeStatus).toBe('pending'); // NOT 'derived'
    expect(store.finalized?.scopeStatus).toBe('pending');
    expect(store.run.chunks_failed).toBe(1);
    expect(store.run.failed_chunks).toHaveLength(1);
    expect(store.run.failed_chunks[0]!.index).toBe(1);
    // The surface names how many sections could not be read.
    expect(store.finalized?.message).toMatch(/could not read 1 section/i);
    // The failed chunk contributes NO nodes; only 3 + 4 + 3 = 10 landed.
    expect(store.nodes.size).toBe(10);
  });

  it('derives a clean 14-node tree and marks scope_status derived', async () => {
    const store = new MemStore();
    const doc = docOf(4, 60);
    const c = classifier([4, 3, 4, 3]); // 14 nodes, no failures
    const res = await drive(store, c, doc);

    expect(res.status).toBe('succeeded');
    expect(store.scopeStatus).toBe('derived');
    expect(store.run.chunks_failed).toBe(0);
    expect(store.nodes.size).toBe(14);
  });

  it('no provider configured fails loudly at blocked, never a silent empty tree', async () => {
    const store = new MemStore();
    const res = await runDerivationSlice(
      { orgId: ORG, requestId: REQ, runId: RUN, claimant: 'w1', sourceText: docOf(2, 60), sourceDocHash: 'h', providerId: null },
      store,
      classifier([2, 2]),
      log,
      { chunkChars: 60 },
    );
    expect(res.status).toBe('blocked');
    expect(store.scopeStatus).toBe('pending');
    expect(store.nodes.size).toBe(0);
  });
});

describe('derivation engine - throttle defers and resumes', () => {
  it('a throttle re-throws, releases the claim, and a retry resumes to completion', async () => {
    const store = new MemStore();
    const doc = docOf(3, 60);
    // First attempt: chunk 0 throttles.
    const throttling = classifier([2, 2, 2], { 0: new LlmThrottledError(1) });
    await expect(
      runDerivationSlice(
        { orgId: ORG, requestId: REQ, runId: RUN, claimant: 'w1', sourceText: doc, sourceDocHash: 'h', providerId: 'p' },
        store,
        throttling,
        log,
        { chunkChars: 60 },
      ),
    ).rejects.toBeInstanceOf(LlmThrottledError);
    // Claim was released; run still resumable at chunk 0.
    expect(store.run.claimed_by).toBeNull();
    expect(store.run.last_processed_chunk).toBe(-1);
    expect(store.run.status).toBe('running');

    // Retry with a healthy classifier resumes and completes.
    const res = await drive(store, classifier([2, 2, 2]), doc, 'w1');
    expect(res.status).toBe('succeeded');
    expect(store.scopeStatus).toBe('derived');
    expect(store.nodes.size).toBe(6);
  });
});

describe('derivation engine - lease fencing', () => {
  it('rejects re-entry by a different live claimant (409 / LeaseHeldError)', async () => {
    const store = new MemStore();
    const doc = docOf(4, 60);
    // w1 processes one chunk and holds a fresh lease (not done yet).
    const first = await runDerivationSlice(
      { orgId: ORG, requestId: REQ, runId: RUN, claimant: 'w1', sourceText: doc, sourceDocHash: 'h', providerId: 'p' },
      store,
      classifier([2, 2, 2, 2]),
      log,
      { chunkChars: 60 },
    );
    expect(first.done).toBe(false);
    expect(store.run.claimed_by).toBe('w1');

    // w2 tries to re-enter while w1's lease is fresh -> rejected.
    await expect(
      runDerivationSlice(
        { orgId: ORG, requestId: REQ, runId: RUN, claimant: 'w2', sourceText: doc, sourceDocHash: 'h', providerId: 'p' },
        store,
        classifier([2, 2, 2, 2]),
        log,
        { chunkChars: 60 },
      ),
    ).rejects.toBeInstanceOf(LeaseHeldError);
  });
});
