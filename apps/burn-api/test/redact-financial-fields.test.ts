import { describe, it, expect } from 'vitest';
import {
  redactFinancialFields,
  redactFinancialRows,
  buildMoneyBlock,
  BURN_FLOORED_SURFACES,
  type MoneyFigures,
} from '../src/lib/redact-financial-fields.js';
import { DENY_ALL_VIEWER_CAPS, type ViewerCaps } from '../src/lib/viewer-caps.js';
import { BurnMoneyBlock } from '@bigbluebam/shared';

/**
 * Burn spec section 12.1, "Serializer identity" and "The surveillance join, enumerated".
 *
 * The load-bearing test in this file is `every one of the eight surfaces`. Round 1 of the
 * spec applied flooring to one route of three and left the other two returning the same
 * per-item dollars, so this suite enumerates the surfaces BY NAME from the exported
 * constant rather than spot-checking a couple. Adding a ninth surface to
 * BURN_FLOORED_SURFACES without a fixture here fails the coverage assertion.
 */

const READ_ALL: ViewerCaps = { financials_read_all: true, costrate_read: true, resolved: true };
const MEMBER: ViewerCaps = { financials_read_all: false, costrate_read: false, resolved: true };
const UNRESOLVED: ViewerCaps = { ...DENY_ALL_VIEWER_CAPS };

// A single bam.time_entry work item. 90 minutes, $210 cost. cost_amount / (minutes / 60)
// = 21000 / 1.5 = $140/hr, which IS the Professor's hourly cost rate to the cent. One row
// is a full disclosure, which is why this shape appears on every surface below.
const workItemRow = () => ({
  id: '11111111-1111-4111-8111-111111111111',
  source_type: 'bam.time_entry',
  source_id: '22222222-2222-4222-8222-222222222222',
  actor_id: '33333333-3333-4333-8333-333333333333',
  project_id: '44444444-4444-4444-8444-444444444444',
  minutes: 90,
  title_snapshot: 'Coconut radio repair',
  billable_amount: 30000,
  cost_amount: 21000,
  currency: 'USD',
  bill_rate_id: '55555555-5555-4555-8555-555555555555',
  burn_cost_rate_id: '66666666-6666-4666-8666-666666666666',
  valuation_basis: 'rate',
  attribution_state: 'attributed',
});

/**
 * One representative payload per surface, each shaped the way that surface really nests.
 * The point of the nesting is that a shallow delete would floor the envelope and leave the
 * same dollars one level down.
 */
const SURFACE_FIXTURES: Record<(typeof BURN_FLOORED_SURFACES)[number], () => unknown> = {
  '/v1/work-items': () => ({ data: [workItemRow(), workItemRow()], next_cursor: null }),

  '/v1/attributions': () => ({
    data: [
      {
        id: '77777777-7777-4777-8777-777777777777',
        state: 'auto_attributed',
        method: 'llm',
        confidence: 0.91,
        // The attribution carries no money of its own (R3-T2); it JOINS the work item.
        work_item: workItemRow(),
      },
    ],
  }),

  '/v1/unscoped': () => ({
    data: [
      {
        bucket: 'sold_by_nobody',
        cluster_label: 'Radio parts',
        item_count: 2,
        amount: 51000,
        items: [workItemRow(), workItemRow()],
        hidden_by_permissions: 1,
      },
    ],
  }),

  '/v1/queue-health': () => ({
    data: {
      sold_by_nobody: { count: 4, unscoped_sold_by_nobody: 120000 },
      unclassified: { count: 2, unscoped_unclassified: 45000 },
      outside_contract: { count: 1, unscoped_outside_contract: 8000 },
      pending_review_amount: 15000,
      awaiting_valuation_amount: 9000,
      oldest_age_days: 12,
      statement: 'These dollars are not in any envelope.',
    },
  }),

  '/v1/change-orders/:id': () => ({
    data: {
      id: '88888888-8888-4888-8888-888888888888',
      engagement_id: '99999999-9999-4999-8999-999999999999',
      body: 'Additional scope for radio repair.',
      scope_table: [
        { deliverable_title: 'Radio repair', envelope_amount: 500000, overage_amount: 51000 },
      ],
      supporting_items: [workItemRow()],
    },
  }),

  'burn_variances.detail': () => ({
    data: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      variance_kind: 'envelope_overrun',
      severity: 'high',
      amount: 51000,
      detail: {
        band: 'over_10pct',
        refs: [{ entity_type: 'burn.work_item', entity_id: workItemRow().id }],
        // JSONB nests arbitrarily. A shallow delete would miss this entirely.
        sample_items: [workItemRow()],
      },
    },
  }),

  'mcp.tool_payload': () => ({
    tool: 'burn_list_unscoped',
    items: [workItemRow()],
    totals: { unscoped_sold_by_nobody: 120000 },
  }),

  'csv.export': () => ({
    header: ['id', 'source_type', 'minutes', 'cost_amount', 'billable_amount'],
    rows: [workItemRow()],
  }),
};

// Recursive key sweep, so a dollar hiding at any depth is caught.
function collectKeys(value: unknown, acc: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, acc);
    return acc;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      acc.add(k);
      collectKeys(v, acc);
    }
  }
  return acc;
}

describe('redactFinancialFields across every one of the eight surfaces', () => {
  it('has a fixture for every surface in BURN_FLOORED_SURFACES', () => {
    expect(Object.keys(SURFACE_FIXTURES).sort()).toEqual([...BURN_FLOORED_SURFACES].sort());
    expect(BURN_FLOORED_SURFACES).toHaveLength(8);
  });

  // Enumerated by name, one test per surface, so a failure names the leaking surface.
  for (const surface of BURN_FLOORED_SURFACES) {
    it(`${surface}: strips cost_amount and billable_amount for a non-read_all caller`, () => {
      const floored = redactFinancialFields(SURFACE_FIXTURES[surface](), MEMBER);
      const keys = collectKeys(floored);
      expect(keys.has('cost_amount')).toBe(false);
      expect(keys.has('billable_amount')).toBe(false);
    });

    it(`${surface}: strips every rate id, envelope and aggregate magnitude`, () => {
      const floored = redactFinancialFields(SURFACE_FIXTURES[surface](), MEMBER);
      const keys = collectKeys(floored);
      for (const forbidden of [
        'bill_rate_id',
        'burn_cost_rate_id',
        'envelope_amount',
        'envelope_remaining',
        'overage_amount',
        'amount',
        'contract_value',
        'attributed_cost',
        'margin_amount',
        'cost_rate_coverage_pct',
        'unscoped_sold_by_nobody',
        'unscoped_unclassified',
        'unscoped_outside_contract',
        'pending_review_amount',
        'awaiting_valuation_amount',
      ]) {
        expect({ surface, forbidden, present: keys.has(forbidden) }).toEqual({
          surface,
          forbidden,
          present: false,
        });
      }
    });

    it(`${surface}: the surveillance join yields no per-person rate`, () => {
      // The section 12.1 join: source_id -> time_entries.user_id through /b3/api/, then
      // cost_amount / hours. `minutes` deliberately SURVIVES (section 13 non-goal 6 keeps
      // per-person hours visible to project members); what must not survive is any dollar
      // to divide by it.
      const floored = redactFinancialFields(SURFACE_FIXTURES[surface](), MEMBER);
      const serialized = JSON.stringify(floored);
      expect(serialized).not.toMatch(/21000/); // the cost figure
      expect(serialized).not.toMatch(/30000/); // the billable figure
    });

    it(`${surface}: a read_all caller is unaffected`, () => {
      const original = SURFACE_FIXTURES[surface]();
      const passed = redactFinancialFields(original, READ_ALL);
      expect(passed).toBe(original);
      expect(collectKeys(passed).has('cost_amount') || surface === '/v1/queue-health').toBe(true);
    });

    it(`${surface}: an unresolvable viewer fails closed exactly like a member`, () => {
      const floored = redactFinancialFields(SURFACE_FIXTURES[surface](), UNRESOLVED);
      expect(collectKeys(floored).has('cost_amount')).toBe(false);
    });
  }

  it('does not mutate the input row', () => {
    const row = workItemRow();
    redactFinancialFields(row, MEMBER);
    expect(row.cost_amount).toBe(21000);
  });

  it('preserves non-floored context so the row is still usable', () => {
    const floored = redactFinancialFields(workItemRow(), MEMBER) as Record<string, unknown>;
    expect(floored.id).toBe(workItemRow().id);
    expect(floored.minutes).toBe(90);
    expect(floored.title_snapshot).toBe('Coconut radio repair');
    expect(floored.attribution_state).toBe('attributed');
  });

  it('redactFinancialRows floors a bare array', () => {
    const rows = redactFinancialRows([workItemRow(), workItemRow()], MEMBER);
    expect(rows).toHaveLength(2);
    expect(collectKeys(rows).has('cost_amount')).toBe(false);
  });

  it('optionally strips clause text (spec 2.4 point 5) while keeping title', () => {
    const deliverable = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      title: 'Rescue raft construction',
      description: 'Contractor shall deliver one seaworthy raft at a rate of $140/hr.',
      clause_ref: 'S 4.2',
      cited_span: { page: 3, quote: 'at a rate of $140/hr', clause_ref: 'S 4.2' },
    };
    const floored = redactFinancialFields(deliverable, MEMBER, { clauseText: true }) as Record<
      string,
      unknown
    >;
    expect(floored.title).toBe('Rescue raft construction');
    expect(floored.description).toBeUndefined();
    expect(floored.clause_ref).toBeUndefined();
    expect((floored.cited_span as Record<string, unknown>).quote).toBeUndefined();
    expect((floored.cited_span as Record<string, unknown>).page).toBe(3);
    // Off by default: the eight money surfaces carry no clause text.
    const moneyOnly = redactFinancialFields(deliverable, MEMBER) as Record<string, unknown>;
    expect(moneyOnly.description).toBeDefined();
  });
});

describe('buildMoneyBlock', () => {
  const base: MoneyFigures = {
    metric_basis: 'true_margin',
    revenue_basis: 'contract_value',
    currency: 'USD',
    as_of: '2026-07-19T08:00:00.000Z',
    revenue_amount: 1800000,
    contract_value: 1800000,
    attributed_billable: 1500000,
    attributed_cost: 1300000,
    margin_amount: 500000,
    margin_pct: 27.78,
    contract_consumption_pct: 83.33,
    cost_rate_coverage_pct: 100,
    margin_state: 'in_progress',
    distinct_contributor_count: 5,
    min_contributors_for_cost_aggregate: 3,
  };

  it('gives a read_all caller the true_margin variant', () => {
    const block = buildMoneyBlock(base, READ_ALL);
    expect(BurnMoneyBlock.parse(block).metric_basis).toBe('true_margin');
  });

  it('gives a member the suppressed variant with NO cost, margin or coverage key', () => {
    const block = buildMoneyBlock(base, MEMBER);
    expect(block.metric_basis).toBe('suppressed');
    const keys = Object.keys(block);
    for (const forbidden of [
      'attributed_cost',
      'margin_amount',
      'margin_pct',
      'cost_rate_coverage_pct',
      'revenue_amount',
      'contract_value',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    // It is a VALID suppressed block, not a stripped true_margin block.
    expect(() => BurnMoneyBlock.parse(block)).not.toThrow();
    expect(JSON.stringify(block)).not.toMatch(/1300000|500000/);
  });

  it('members still get contract_consumption_pct (derived from contract value, not cost)', () => {
    const block = buildMoneyBlock(base, MEMBER);
    expect(block.metric_basis === 'suppressed' && block.contract_consumption_pct).toBe(83.33);
  });

  it('names the contributor floor when the chain is below it', () => {
    const block = buildMoneyBlock({ ...base, distinct_contributor_count: 1 }, MEMBER);
    expect(block.metric_basis === 'suppressed' && block.suppressed_reason).toBe(
      'insufficient_contributors',
    );
  });

  it('names the permission when the chain is above the floor', () => {
    const block = buildMoneyBlock(base, MEMBER);
    expect(block.metric_basis === 'suppressed' && block.suppressed_reason).toBe(
      'insufficient_permission',
    );
  });

  it('names an outage distinctly, so a blip is not read as a contributor floor', () => {
    const block = buildMoneyBlock({ ...base, distinct_contributor_count: 1 }, UNRESOLVED);
    expect(block.metric_basis === 'suppressed' && block.suppressed_reason).toBe(
      'unresolved_viewer',
    );
  });

  it('a read_all caller still sees the figures below the contributor floor', () => {
    // Spec 2.4 point 17: the floor is a disclosure control against members, not an
    // accounting rule.
    const block = buildMoneyBlock({ ...base, distinct_contributor_count: 1 }, READ_ALL);
    expect(block.metric_basis).toBe('true_margin');
  });

  it('emits contract_consumption with no margin key when coverage is zero', () => {
    const block = buildMoneyBlock(
      {
        ...base,
        metric_basis: 'contract_consumption',
        revenue_basis: 'billable_recognized',
        cost_rate_coverage_pct: 0,
        attributed_cost: null,
        margin_amount: null,
        margin_pct: null,
      },
      READ_ALL,
    );
    expect(BurnMoneyBlock.parse(block).metric_basis).toBe('contract_consumption');
    expect(JSON.stringify(block)).not.toMatch(/margin/);
  });

  it('cannot emit contract_consumption or true_margin to a non-read_all caller at all', () => {
    for (const basis of ['true_margin', 'contract_consumption'] as const) {
      for (const caps of [MEMBER, UNRESOLVED]) {
        expect(buildMoneyBlock({ ...base, metric_basis: basis }, caps).metric_basis).toBe(
          'suppressed',
        );
      }
    }
  });
});
