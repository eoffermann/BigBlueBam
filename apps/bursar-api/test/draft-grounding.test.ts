import { describe, it, expect } from 'vitest';
import {
  buildDraftGrounding,
  type DraftGroundingSource,
  type GroundingLine,
  type GroundingNode,
} from '../src/lib/draft-grounding.js';

// M8 (spec 5.7): the grounding builder can select ONLY lines of the target offer and nodes of the
// target request. This suite asserts THE BUILDER: given a store holding rows for multiple offers
// and requests, the builder returns strictly the target's rows and cannot reach across.

const ORG = '00000000-0000-0000-0000-000000000001';

// A store scoped exactly like the DB: offerLines(org, offerId) returns only that offer's lines,
// requestNodes(org, requestId) only that request's nodes. It also RECORDS every id it was asked
// for so the test can prove the builder never queried a foreign id.
function makeSource() {
  const lines: Record<string, GroundingLine[]> = {
    offerA: [{ id: 'la1', ordinal: 0, raw_text: 'A line', line_role: 'base', unit: null, quantity: 1 }],
    offerB: [{ id: 'lb1', ordinal: 0, raw_text: 'B line (SECRET rival bid)', line_role: 'base', unit: null, quantity: 1 }],
  };
  const nodes: Record<string, GroundingNode[]> = {
    reqX: [{ id: 'nx1', ordinal: 0, title: 'X node', normative_strength: 'mandatory' }],
    reqY: [{ id: 'ny1', ordinal: 0, title: 'Y node (OTHER request)', normative_strength: 'mandatory' }],
  };
  const askedOffers: string[] = [];
  const askedRequests: string[] = [];
  const source: DraftGroundingSource = {
    async offerLines(orgId, offerId) {
      askedOffers.push(offerId);
      expect(orgId).toBe(ORG);
      return lines[offerId] ?? [];
    },
    async requestNodes(orgId, requestId) {
      askedRequests.push(requestId);
      expect(orgId).toBe(ORG);
      return nodes[requestId] ?? [];
    },
  };
  return { source, askedOffers, askedRequests };
}

describe('buildDraftGrounding confinement', () => {
  it('returns only the target offer lines and target request nodes', async () => {
    const { source } = makeSource();
    const g = await buildDraftGrounding(source, ORG, { offerId: 'offerA', requestId: 'reqX' });
    expect(g.lines.map((l) => l.id)).toEqual(['la1']);
    expect(g.nodes.map((n) => n.id)).toEqual(['nx1']);
  });

  it('never queries any offer or request other than the two it was given', async () => {
    const { source, askedOffers, askedRequests } = makeSource();
    await buildDraftGrounding(source, ORG, { offerId: 'offerA', requestId: 'reqX' });
    // The SECRET rival offer B and the OTHER request Y must never have been touched.
    expect(askedOffers).toEqual(['offerA']);
    expect(askedRequests).toEqual(['reqX']);
    expect(askedOffers).not.toContain('offerB');
    expect(askedRequests).not.toContain('reqY');
  });

  it('cannot leak offer B lines into a request X / offer A draft', async () => {
    const { source } = makeSource();
    const g = await buildDraftGrounding(source, ORG, { offerId: 'offerA', requestId: 'reqX' });
    const text = JSON.stringify(g);
    expect(text).not.toContain('SECRET rival bid');
    expect(text).not.toContain('OTHER request');
  });

  it('selects no lines when there is no offer in scope', async () => {
    const { source, askedOffers } = makeSource();
    const g = await buildDraftGrounding(source, ORG, { offerId: null, requestId: 'reqX' });
    expect(g.lines).toEqual([]);
    expect(askedOffers).toEqual([]); // never even asked for lines
    expect(g.nodes.map((n) => n.id)).toEqual(['nx1']);
  });
});
