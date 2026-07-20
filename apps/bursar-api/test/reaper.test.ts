import { describe, it, expect } from 'vitest';
import {
  reapOrg,
  selectStaleRuns,
  selectStaleOffers,
  type ReaperStore,
  type ReaperRun,
  type ReaperOffer,
} from '../src/services/engines/reaper.engine.js';

// The reaper unwedges a killed derivation WITHOUT manual psql (spec 3.2 item 10): a stale
// 'running' run reverts to 'partial' AND - transactionally, together - its owning request's
// scope_status reverts from 'deriving' to 'pending', so confirm stops returning 409 forever.

const ORG = 'org-1';
const LEASE = 5 * 60 * 1000;

describe('reaper pure selectors', () => {
  const now = Date.now();
  it('selects a running run with a lapsed / absent heartbeat', () => {
    const runs: ReaperRun[] = [
      { id: 'stale', status: 'running', heartbeat_at: new Date(now - LEASE - 1000) },
      { id: 'never', status: 'running', heartbeat_at: null },
      { id: 'fresh', status: 'running', heartbeat_at: new Date(now - 1000) },
      { id: 'done', status: 'succeeded', heartbeat_at: new Date(now - LEASE - 1000) },
    ];
    expect(selectStaleRuns(runs, now, LEASE).sort()).toEqual(['never', 'stale']);
  });

  it('selects an offer stuck parsing past the lease', () => {
    const offers: ReaperOffer[] = [
      { id: 'stuck', normalization_status: 'parsing', updated_at: new Date(now - LEASE - 1) },
      { id: 'recent', normalization_status: 'parsing', updated_at: new Date(now - 1000) },
      { id: 'done', normalization_status: 'parsed', updated_at: new Date(now - LEASE - 1) },
    ];
    expect(selectStaleOffers(offers, now, LEASE)).toEqual(['stuck']);
  });
});

/** In-memory store modelling the transactional revert: run -> partial AND owning request -> pending. */
class MemReaperStore implements ReaperStore {
  runs: Array<{ id: string; request_id: string; status: string; heartbeat_at: Date | null }>;
  requests: Map<string, { scope_status: string }>;
  offers: Array<{ id: string; normalization_status: string | null; updated_at: Date | null }>;

  constructor(seed: {
    runs: MemReaperStore['runs'];
    requests: Record<string, string>;
    offers?: MemReaperStore['offers'];
  }) {
    this.runs = seed.runs;
    this.requests = new Map(Object.entries(seed.requests).map(([id, s]) => [id, { scope_status: s }]));
    this.offers = seed.offers ?? [];
  }

  async reapStaleRuns(_orgId: string, leaseMs: number) {
    const now = Date.now();
    const stale = this.runs.filter(
      (r) => r.status === 'running' && (!r.heartbeat_at || now - r.heartbeat_at.getTime() >= leaseMs),
    );
    let requestsReverted = 0;
    for (const r of stale) {
      r.status = 'partial'; // 1. run -> partial
      const req = this.requests.get(r.request_id);
      if (req && req.scope_status === 'deriving') {
        req.scope_status = 'pending'; // 2. owning request -> pending, same "transaction"
        requestsReverted += 1;
      }
    }
    return { runs_reverted: stale.length, requests_reverted: requestsReverted };
  }

  async reapStaleOffers(_orgId: string, leaseMs: number) {
    const now = Date.now();
    const stale = this.offers.filter(
      (o) => o.normalization_status === 'parsing' && (!o.updated_at || now - o.updated_at.getTime() >= leaseMs),
    );
    for (const o of stale) o.normalization_status = 'failed';
    return stale.length;
  }
}

describe('reapOrg transactional revert', () => {
  it('unwedges a killed derivation: run -> partial AND request -> pending, together', async () => {
    const store = new MemReaperStore({
      runs: [{ id: 'run-1', request_id: 'req-1', status: 'running', heartbeat_at: new Date(Date.now() - LEASE - 5000) }],
      requests: { 'req-1': 'deriving' },
    });
    const summary = await reapOrg(store, ORG, LEASE);
    expect(summary.runs_reverted).toBe(1);
    expect(summary.requests_reverted).toBe(1);
    expect(store.runs[0]!.status).toBe('partial');
    expect(store.requests.get('req-1')!.scope_status).toBe('pending'); // confirm is unblocked again
  });

  it('leaves a fresh, still-alive derivation untouched (does not race the writer)', async () => {
    const store = new MemReaperStore({
      runs: [{ id: 'run-1', request_id: 'req-1', status: 'running', heartbeat_at: new Date(Date.now() - 1000) }],
      requests: { 'req-1': 'deriving' },
    });
    const summary = await reapOrg(store, ORG, LEASE);
    expect(summary.runs_reverted).toBe(0);
    expect(store.runs[0]!.status).toBe('running');
    expect(store.requests.get('req-1')!.scope_status).toBe('deriving');
  });

  it('unwedges an offer stuck parsing', async () => {
    const store = new MemReaperStore({
      runs: [],
      requests: {},
      offers: [{ id: 'off-1', normalization_status: 'parsing', updated_at: new Date(Date.now() - LEASE - 1) }],
    });
    const summary = await reapOrg(store, ORG, LEASE);
    expect(summary.offers_reverted).toBe(1);
    expect(store.offers[0]!.normalization_status).toBe('failed');
  });
});
