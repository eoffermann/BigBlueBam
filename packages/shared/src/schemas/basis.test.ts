import { describe, it, expect } from 'vitest';
import {
  createBasisMetricSchema,
  basisDefinitionSchema,
  basisMetricSchema,
  basisMetricWithVersionSchema,
  basisExplainRequestSchema,
} from './basis.js';

// The Basis contract is shared between basis-api and the SPA (spec section 4).
// These guard the shapes the client relies on against silent drift.

describe('createBasisMetricSchema', () => {
  const base = {
    slug: 'monthly_revenue',
    name: 'Monthly Revenue',
    unit: 'currency' as const,
    definition: {
      source_product: 'bill',
      source_entity: 'invoices',
      measure: { field: 'amount', agg: 'sum' as const },
      time_column: 'created_at',
    },
  };

  it('accepts a minimal valid metric and defaults favorable_direction/default_dimensions', () => {
    const parsed = createBasisMetricSchema.parse(base);
    expect(parsed.favorable_direction).toBe('up');
    expect(parsed.definition.default_dimensions).toEqual([]);
  });

  it('rejects a non-snake_case slug', () => {
    expect(() => createBasisMetricSchema.parse({ ...base, slug: 'Monthly-Revenue' })).toThrow();
  });

  it('rejects an unknown unit', () => {
    expect(() => createBasisMetricSchema.parse({ ...base, unit: 'bushels' })).toThrow();
  });

  it('rejects an unknown aggregation', () => {
    const bad = { ...base, definition: { ...base.definition, measure: { field: 'amount', agg: 'median' } } };
    expect(() => createBasisMetricSchema.parse(bad)).toThrow();
  });
});

describe('basisDefinitionSchema', () => {
  it('requires source_product, source_entity, measure, and time_column', () => {
    expect(() => basisDefinitionSchema.parse({ source_product: 'bill' })).toThrow();
  });
});

describe('response schemas (single source of truth for the SPA)', () => {
  const metric = {
    id: '00000000-0000-0000-0000-000000000001',
    organization_id: '00000000-0000-0000-0000-000000000002',
    slug: 'x',
    name: 'X',
    description: null,
    unit: 'count',
    favorable_direction: 'up',
    owner_id: null,
    certification: 'draft',
    current_version_id: null,
    related_apps: [],
    target: null,
    resolve_status: 'ok',
    resolve_failed_at: null,
    last_breach_at: null,
    last_breach_direction: null,
    created_by: null,
    created_at: '2026-07-17T00:00:00.000Z',
    updated_at: '2026-07-17T00:00:00.000Z',
  };

  it('parses a persisted metric row', () => {
    expect(basisMetricSchema.parse(metric).id).toBe(metric.id);
  });

  it('parses the metric+currentVersion envelope with a null version', () => {
    const parsed = basisMetricWithVersionSchema.parse({ metric, currentVersion: null });
    expect(parsed.currentVersion).toBeNull();
  });
});

describe('basisExplainRequestSchema', () => {
  it('requires ISO datetime periods and allows an optional dimension', () => {
    const ok = basisExplainRequestSchema.parse({
      period_a: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-30T00:00:00.000Z' },
      period_b: { from: '2026-07-01T00:00:00.000Z', to: '2026-07-31T00:00:00.000Z' },
    });
    expect(ok.dimension).toBeUndefined();
    expect(() =>
      basisExplainRequestSchema.parse({
        period_a: { from: 'not-a-date', to: 'nope' },
        period_b: { from: 'x', to: 'y' },
      }),
    ).toThrow();
  });
});
