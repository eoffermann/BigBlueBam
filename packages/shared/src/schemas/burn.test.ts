import { describe, it, expect } from 'vitest';
import {
  BurnMoneyBlock,
  BurnMoneySuppressed,
  BurnMoneyContractConsumption,
  BurnMoneyTrueMargin,
  BurnRuleMatch,
  burnDeliverableUpdateSchema,
  burnPrecheckRequestSchema,
  burnPrecheckLabelSchema,
  burnEngagementCreateRefined,
  BURN_READ_ALL_FLOORED_KEYS,
} from './burn.js';
import { burnPrecheckKey, burnPrecheckNamespaceOf } from '../burn-precheck-key.js';

// Burn spec section 12.1 assertions covering the shared contract (section 1.2.2, 2.4).

describe('BurnMoneyBlock discriminated union', () => {
  const asOf = '2026-07-19T08:00:00.000Z';

  it('CANNOT be constructed without a metric_basis discriminator', () => {
    // The exact failure the union exists to prevent: a money object with figures and no
    // statement of what kind of number they are.
    const noDiscriminator = {
      revenue_basis: 'contract_value',
      currency: 'USD',
      margin_amount: 500000,
      margin_pct: 27.5,
      attributed_cost: 1300000,
      cost_rate_coverage_pct: 100,
      as_of: asOf,
    };
    const parsed = BurnMoneyBlock.safeParse(noDiscriminator);
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown metric_basis', () => {
    expect(
      BurnMoneyBlock.safeParse({ metric_basis: 'margin', currency: 'USD', as_of: asOf }).success,
    ).toBe(false);
  });

  it('accepts a true_margin block carrying margin, cost and coverage', () => {
    const parsed = BurnMoneyBlock.safeParse({
      metric_basis: 'true_margin',
      revenue_basis: 'contract_value',
      currency: 'USD',
      revenue_amount: 1800000,
      margin_amount: 500000,
      margin_pct: 27.78,
      attributed_cost: 1300000,
      attributed_billable: 1500000,
      contract_consumption_pct: 83.33,
      cost_rate_coverage_pct: 100,
      margin_state: 'in_progress',
      as_of: asOf,
    });
    expect(parsed.success).toBe(true);
  });

  it('the contract_consumption variant has NO margin key at all', () => {
    // A model cannot read a field that is not there. Asserted on the schema shape, not on
    // one sample object, so adding a margin key to the variant fails this test.
    const keys = Object.keys(BurnMoneyContractConsumption.shape);
    expect(keys).not.toContain('margin_amount');
    expect(keys).not.toContain('margin_pct');
    expect(keys).not.toContain('attributed_cost');
    expect(keys.filter((k) => k.includes('margin'))).toEqual([]);
  });

  it('the suppressed variant carries NO cost, margin or coverage key', () => {
    const keys = Object.keys(BurnMoneySuppressed.shape);
    for (const forbidden of [
      'attributed_cost',
      'attributed_billable',
      'margin_amount',
      'margin_pct',
      'cost_rate_coverage_pct',
      'revenue_amount',
      'contract_value',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    // What it DOES carry: the reason, the basis, the member-safe consumption figure, as_of.
    expect(keys.sort()).toEqual(
      [
        'as_of',
        'contract_consumption_pct',
        'currency',
        'metric_basis',
        'revenue_basis',
        'suppressed_reason',
      ].sort(),
    );
  });

  it('the suppressed variant REJECTS a smuggled cost key rather than silently dropping it', () => {
    // .strict() is what turns an accidental spread of a cost-bearing row into a hard
    // failure. Without it, an implementer spreading the rollup row into the response would
    // ship attributed_cost to every member and Zod would say nothing.
    const parsed = BurnMoneySuppressed.safeParse({
      metric_basis: 'suppressed',
      suppressed_reason: 'insufficient_contributors',
      revenue_basis: 'contract_value',
      currency: 'USD',
      contract_consumption_pct: 83.33,
      as_of: asOf,
      attributed_cost: 1300000,
    });
    expect(parsed.success).toBe(false);
  });

  it('a valid suppressed block round-trips through the union and stays suppressed', () => {
    const block = {
      metric_basis: 'suppressed' as const,
      suppressed_reason: 'insufficient_contributors' as const,
      revenue_basis: 'contract_value' as const,
      currency: 'USD',
      contract_consumption_pct: 83.33,
      as_of: asOf,
    };
    const parsed = BurnMoneyBlock.parse(block);
    expect(parsed.metric_basis).toBe('suppressed');
    expect(JSON.stringify(parsed)).not.toMatch(/margin/);
    expect(JSON.stringify(parsed)).not.toMatch(/cost/);
  });

  it('no serialized contract_consumption response carries the string "margin"', () => {
    // Section 12.1: "No response carries the string 'margin' when
    // metric_basis='contract_consumption'". revenue_basis values are deliberately named so
    // none of them contains it either.
    const parsed = BurnMoneyContractConsumption.parse({
      metric_basis: 'contract_consumption',
      revenue_basis: 'billable_recognized',
      currency: 'USD',
      contract_value: 1800000,
      attributed_billable: 1500000,
      contract_consumption_pct: 83.33,
      cost_rate_coverage_pct: 0,
      completion_state: 'in_progress',
      as_of: asOf,
    });
    // The WHOLE serialized object, with nothing excluded. A key named `margin_state` here
    // would fail this, which is why the variant carries `completion_state` instead.
    expect(JSON.stringify(parsed)).not.toMatch(/margin/);
  });

  it('true_margin is the only variant that can carry margin figures', () => {
    const marginKeys = Object.keys(BurnMoneyTrueMargin.shape).filter((k) => k.includes('margin'));
    expect(marginKeys).toContain('margin_amount');
    expect(marginKeys).toContain('margin_pct');
  });
});

describe('BURN_READ_ALL_FLOORED_KEYS', () => {
  it('covers the per-row disclosure that IS a cost rate', () => {
    // cost_amount / (minutes / 60) on one bam.time_entry row is that person's hourly cost
    // rate to the cent (R2-S3).
    expect(BURN_READ_ALL_FLOORED_KEYS).toContain('cost_amount');
    expect(BURN_READ_ALL_FLOORED_KEYS).toContain('billable_amount');
  });

  it('covers the envelope figures that binary-search back to contract_value', () => {
    for (const k of ['envelope_amount', 'envelope_remaining', 'envelope_consumed', 'overage_amount', 'contract_value']) {
      expect(BURN_READ_ALL_FLOORED_KEYS).toContain(k);
    }
  });

  it('has no duplicates', () => {
    expect(new Set(BURN_READ_ALL_FLOORED_KEYS).size).toBe(BURN_READ_ALL_FLOORED_KEYS.length);
  });
});

describe('BurnRuleMatch', () => {
  it('rejects an empty match (a rule that matches the whole ledger)', () => {
    expect(BurnRuleMatch.safeParse({}).success).toBe(false);
  });

  it('rejects regex metacharacters in title_pattern (no regex timeout exists in Node)', () => {
    expect(BurnRuleMatch.safeParse({ title_pattern: '(a+)+$' }).success).toBe(false);
    expect(BurnRuleMatch.safeParse({ title_pattern: 'Luau catering' }).success).toBe(true);
  });

  it('accepts a match constraining one discriminating key', () => {
    expect(BurnRuleMatch.safeParse({ source_types: ['bill.expense'] }).success).toBe(true);
  });
});

describe('write-path shapes that close a documented hole', () => {
  it('PATCH /v1/deliverables cannot set envelope_amount or is_active', () => {
    expect(
      burnDeliverableUpdateSchema.safeParse({ title: 'Rescue raft', envelope_amount: 500000 })
        .success,
    ).toBe(false);
    expect(burnDeliverableUpdateSchema.safeParse({ is_active: true }).success).toBe(false);
    expect(burnDeliverableUpdateSchema.safeParse({ review_status: 'confirmed' }).success).toBe(true);
  });

  it('a caller-supplied precheck idempotency key is rejected', () => {
    expect(
      burnPrecheckRequestSchema.safeParse({
        work_ref_type: 'bill.expense',
        proposed_amount: 100,
        currency: 'USD',
        idempotency_key: 'usr:deadbeef',
      }).success,
    ).toBe(false);
  });

  it('the precheck label body admits exactly one authority at a time', () => {
    expect(burnPrecheckLabelSchema.safeParse({ advisory_feedback: 'right_call' }).success).toBe(true);
    expect(burnPrecheckLabelSchema.safeParse({ advisory_feedback: 'wrong_call' }).success).toBe(true);
    expect(burnPrecheckLabelSchema.safeParse({ flag_for_review: true }).success).toBe(true);
    // Both at once would let one authority ride along with the other.
    expect(
      burnPrecheckLabelSchema.safeParse({
        advisory_feedback: 'right_call',
        override_reason_code: 'gate_wrong',
      }).success,
    ).toBe(false);
  });

  it('a retainer engagement requires a period length', () => {
    expect(
      burnEngagementCreateRefined.safeParse({
        title: 'Howell standing retainer',
        envelope_basis: 'retainer',
      }).success,
    ).toBe(false);
    expect(
      burnEngagementCreateRefined.safeParse({
        title: 'Howell standing retainer',
        envelope_basis: 'retainer',
        period_length_days: 30,
      }).success,
    ).toBe(true);
  });
});

describe('burnPrecheckKey', () => {
  const secret = 'x'.repeat(48);
  const base = {
    namespace: 'svc' as const,
    work_ref_type: 'bill.expense',
    work_ref_id: '11111111-1111-4111-8111-111111111111',
    proposed_amount: 1,
    currency: 'USD',
  };

  it('is deterministic for the same charge', () => {
    expect(burnPrecheckKey(secret, base)).toBe(burnPrecheckKey(secret, base));
  });

  it('defeats the banked-verdict attack: amount is inside the HMAC', () => {
    const cheap = burnPrecheckKey(secret, { ...base, proposed_amount: 1 });
    const expensive = burnPrecheckKey(secret, { ...base, proposed_amount: 6_000_000 });
    expect(cheap).not.toBe(expensive);
  });

  it('keeps svc: and usr: namespaces distinct in the prefix AND in the digest', () => {
    const svc = burnPrecheckKey(secret, { ...base, namespace: 'svc' });
    const usr = burnPrecheckKey(secret, { ...base, namespace: 'usr' });
    expect(burnPrecheckNamespaceOf(svc)).toBe('svc');
    expect(burnPrecheckNamespaceOf(usr)).toBe('usr');
    expect(svc.slice(4)).not.toBe(usr.slice(4));
  });

  it('varies on currency, work_ref_type, work_ref_id and attempt_nonce', () => {
    const k = burnPrecheckKey(secret, base);
    expect(burnPrecheckKey(secret, { ...base, currency: 'EUR' })).not.toBe(k);
    expect(burnPrecheckKey(secret, { ...base, work_ref_type: 'manual' })).not.toBe(k);
    expect(burnPrecheckKey(secret, { ...base, work_ref_id: null })).not.toBe(k);
    expect(burnPrecheckKey(secret, { ...base, attempt_nonce: 'n2' })).not.toBe(k);
  });

  it('cannot be collided by shifting a field boundary', () => {
    const a = burnPrecheckKey(secret, { ...base, work_ref_type: 'a', work_ref_id: 'b' });
    const b = burnPrecheckKey(secret, { ...base, work_ref_type: 'ab', work_ref_id: '' });
    expect(a).not.toBe(b);
  });

  it('fits the varchar(160) idempotency_key column', () => {
    expect(burnPrecheckKey(secret, base).length).toBeLessThanOrEqual(160);
  });

  it('refuses to derive a forgeable key from an empty secret', () => {
    expect(() => burnPrecheckKey('', base)).toThrow(/empty/i);
  });
});
