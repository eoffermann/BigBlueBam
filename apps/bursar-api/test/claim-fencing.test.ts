import { describe, it, expect } from 'vitest';
import {
  runLevelingSlice,
  LevelingLeaseHeldError,
  type LevelingStore,
  type LevelingRunRow,
  type CoverageClassifier,
} from '../src/services/engines/leveling.engine.js';
import type { AdjudicationSettings } from '../src/services/engines/coverage-adjudication.js';
import type { RawCoverageAnswer } from '../src/services/engines/leveling-classifier.js';

const SETTINGS: AdjudicationSettings & { max_lines_per_window: number; window_overlap_lines: number } = {
  node_term_overlap_floor: 0.25,
  blanket_cumulative_cap: 4,
  evidence_concentration_floor: 0.5,
  blanket_fanout_cap: 4,
  max_lines_per_window: 80,
  window_overlap_lines: 10,
};

const LOG = { info: () => {}, warn: () => {}, debug: () => {} };

// A classifier that covers every node against the one line.
const CLASSIFIER: CoverageClassifier = {
  async classifyBatch(_lines, nodes) {
    const m = new Map<string, RawCoverageAnswer>();
    for (const n of nodes) {
      m.set(n.scope_node_id, {
        scope_node_id: n.scope_node_id,
        verdict: 'covered',
        cited_offer_line_id: 'L0',
        quote: 'Site installation',
        classifier_confidence: 0.9,
        rejected_candidates: [],
      });
    }
    return m;
  },
};

function baseRun(): LevelingRunRow {
  return {
    id: 'run-1',
    organization_id: 'org-1',
    request_id: 'req-1',
    status: 'running',
    last_processed_offer_index: -1,
    offer_count: 1,
    node_count: 1,
    llm_calls_used: 0,
    coverage_written: 0,
    claimed_by: null,
    heartbeat_at: null,
    max_llm_calls_per_run: 250,
  };
}

interface FenceFlags {
  windowResultOk?: boolean;
  coverageOk?: boolean;
  checkpointOk?: boolean;
  finalizeOk?: boolean;
}

function makeStore(flags: FenceFlags = {}): LevelingStore {
  const run = baseRun();
  return {
    async loadRun() {
      return { ...run };
    },
    async claim() {
      run.claimed_by = 'me';
      return { ...run, claimed_by: 'me' };
    },
    async loadOffers() {
      return [{ offer_id: 'offer-1', parse_quality: 0.9, blanket_suspected: false, injection_suspected: false, normalization_status: 'parsed', currency: 'USD' }];
    },
    async loadNodes() {
      return [{ scope_node_id: 'n0', parent_id: null, title: 'Site installation', description: null, normative_strength: 'mandatory', quantity: null, unit: null }];
    },
    async loadLines() {
      return [{ offer_line_id: 'L0', ordinal: 0, raw_text: 'Site installation $3,200', line_role: 'base', blanket_claim: false, exclusion_hit: false, extended_minor: 320000 }];
    },
    async loadWindowResults() {
      return new Map();
    },
    async writeWindowResult() {
      return flags.windowResultOk ?? true;
    },
    async writeCoverage() {
      return flags.coverageOk ?? true;
    },
    async writeOfferCounters() {},
    async writeTotals() {},
    async checkpoint() {
      return flags.checkpointOk ?? true;
    },
    async finalize() {
      return flags.finalizeOk ?? true;
    },
    async release() {},
  };
}

const input = {
  orgId: 'org-1',
  requestId: 'req-1',
  runId: 'run-1',
  claimant: 'me',
  providerId: 'prov-1',
  settings: SETTINGS,
  parseQualityFloor: 0.35,
};

describe('claim fencing: a zero-row conditional update ABORTS the slice (spec: leveling engine)', () => {
  it('a lost window-result write aborts with LevelingLeaseHeldError', async () => {
    await expect(runLevelingSlice(input, makeStore({ windowResultOk: false }), CLASSIFIER, LOG)).rejects.toBeInstanceOf(LevelingLeaseHeldError);
  });
  it('a lost coverage write aborts with LevelingLeaseHeldError', async () => {
    await expect(runLevelingSlice(input, makeStore({ coverageOk: false }), CLASSIFIER, LOG)).rejects.toBeInstanceOf(LevelingLeaseHeldError);
  });
  it('a lost checkpoint aborts with LevelingLeaseHeldError', async () => {
    await expect(runLevelingSlice(input, makeStore({ checkpointOk: false }), CLASSIFIER, LOG)).rejects.toBeInstanceOf(LevelingLeaseHeldError);
  });
});

describe('happy-path slice + no-provider blocking', () => {
  it('processes the single offer and finalizes succeeded', async () => {
    const result = await runLevelingSlice(input, makeStore(), CLASSIFIER, LOG);
    expect(result.done).toBe(true);
    expect(result.status).toBe('succeeded');
    expect(result.processedOfferId).toBe('offer-1');
  });
  it('a run with no provider fails loudly at blocked (never a silent empty leveling)', async () => {
    const result = await runLevelingSlice({ ...input, providerId: null }, makeStore(), CLASSIFIER, LOG);
    expect(result.status).toBe('blocked');
    expect(result.done).toBe(true);
  });
});
