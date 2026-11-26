import { describe, expect, it } from 'vitest';
import { CacheService } from '../src/services/cache.service.js';

// #275: the ad-hoc result cache key must identify the query. The old hash serialized the config
// with an array replacer (every nested object became `{}`) and left product/entity out, so a
// member's /query/preview could prime the entry a certified Basis metric read.

const svc = new CacheService({} as never);
const ORG = '57db0001-3f0e-463f-b514-1cd14fd14241';
const RANGE = { start: '2026-01-01', end: '2026-02-01' };

const base = {
  measures: [{ field: 'amount', agg: 'sum', alias: 'value' }],
  time_dimension: { field: 'created_at', granularity: 'day' },
  filters: [{ field: 'status', op: 'eq', value: 'paid' }],
  dimensions: [{ field: 'client_id' }],
  date_range: RANGE,
};

const key = (product: string, entity: string, config: Record<string, unknown>) => svc.adHocKey(product, entity, config, ORG);

describe('Bench ad-hoc cache key (#275)', () => {
  it('the two configs from the issue (same shape, different nested fields) no longer collide', () => {
    const a = { measures: [{ field: 'amount', agg: 'sum', alias: 'value' }], time_dimension: { field: 'created_at' }, date_range: RANGE };
    const b = { measures: [{ field: 'value', agg: 'count', alias: 'value' }], time_dimension: { field: 'closed_at' }, date_range: RANGE };
    expect(key('bill', 'invoices', a)).not.toBe(key('bill', 'invoices', b));
  });

  it('differs when only one nested value differs', () => {
    const k = key('bill', 'invoices', base);
    const variants = [
      { ...base, measures: [{ ...base.measures[0], field: 'tax' }] },
      { ...base, measures: [{ ...base.measures[0], agg: 'avg' }] },
      { ...base, filters: [{ ...base.filters[0], value: 'void' }] },
      { ...base, dimensions: [{ field: 'project_id' }] },
      { ...base, time_dimension: { ...base.time_dimension, granularity: 'month' } },
    ];
    for (const v of variants) expect(key('bill', 'invoices', v)).not.toBe(k);
  });

  it('differs when only the data source (product) or the entity differs', () => {
    const k = key('bill', 'invoices', base);
    expect(key('bond', 'invoices', base)).not.toBe(k);
    expect(key('bill', 'expenses', base)).not.toBe(k);
  });

  it('is the same for the same query whatever the key order, and is org-scoped', () => {
    const reordered = {
      date_range: { end: RANGE.end, start: RANGE.start },
      dimensions: base.dimensions,
      filters: [{ value: 'paid', op: 'eq', field: 'status' }],
      time_dimension: { granularity: 'day', field: 'created_at' },
      measures: [{ alias: 'value', agg: 'sum', field: 'amount' }],
    };
    expect(key('bill', 'invoices', reordered)).toBe(key('bill', 'invoices', base));
    expect(key('bill', 'invoices', base)).toMatch(new RegExp(`^bench:adhoc:v2:${ORG}:`));
    expect(svc.adHocKey('bill', 'invoices', base, '00000000-0000-4000-8000-000000000001')).not.toBe(key('bill', 'invoices', base));
  });

  it('still refuses to cache a range that includes today', () => {
    expect(key('bill', 'invoices', { ...base, date_range: { preset: 'today' } })).toBeNull();
  });
});
