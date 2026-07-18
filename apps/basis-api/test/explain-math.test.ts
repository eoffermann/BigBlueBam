import { describe, it, expect } from 'vitest';
import {
  classifyDimension,
  computeDrivers,
  shapeForRead,
  shapeClassBDrivers,
  CLASS_A_DIMENSIONS,
  type StoredExplanationRow,
} from '../src/services/explain-math.js';
import type { BasisDriver } from '@bigbluebam/shared';

// Spec section 9: leak-safety + correctness invariants that a Playwright happy
// path cannot cover. These exercise the pure decomposition + read-time shaping.

describe('classifyDimension (Class-A allowlist)', () => {
  it('classifies the curated bounded enums as Class A', () => {
    for (const dim of CLASS_A_DIMENSIONS) {
      expect(classifyDimension(dim)).toBe('A');
    }
  });

  it('fails closed (Class B) for generic/high-cardinality names (security #55)', () => {
    for (const dim of ['type', 'category', 'kind', 'tier', 'owner_id', 'email', 'customer']) {
      expect(classifyDimension(dim)).toBe('B');
    }
  });
});

describe('computeDrivers additive decomposition invariant', () => {
  it('sum(contribution_abs) === delta_abs exactly', () => {
    const a = new Map([
      ['high', 4],
      ['medium', 3],
      ['low', 1],
    ]);
    const b = new Map([
      ['high', 8],
      ['medium', 6],
      ['low', 2],
      ['urgent', 2],
    ]);
    const { drivers, deltaAbs } = computeDrivers(a, b, 'A');
    const sum = drivers.reduce((s, d) => s + d.contribution_abs, 0);
    expect(sum).toBeCloseTo(deltaAbs, 10);
    // b total 18 - a total 8 = 10
    expect(deltaAbs).toBe(10);
  });

  it('contribution_pct sums to ~100 when delta_abs != 0', () => {
    const a = new Map([['x', 10]]);
    const b = new Map([['x', 20]]);
    const { drivers } = computeDrivers(a, b, 'A');
    const pct = drivers.reduce((s, d) => s + d.contribution_pct, 0);
    expect(pct).toBeCloseTo(100, 6);
  });

  it('deltaPct is null when the base period total is zero (avoids /0)', () => {
    const a = new Map<string, number>();
    const b = new Map([['x', 5]]);
    const { deltaPct, deltaAbs } = computeDrivers(a, b, 'A');
    expect(deltaAbs).toBe(5);
    expect(deltaPct).toBeNull();
  });

  it('sorts drivers by descending magnitude and labels only Class A', () => {
    const a = new Map([['big', 0], ['small', 0]]);
    const b = new Map([['big', 100], ['small', 3]]);
    const aRes = computeDrivers(a, b, 'A');
    expect(aRes.drivers[0]!.dimension_value).toBe('big');
    expect(aRes.drivers[0]!.label).toBe('big');
    const bRes = computeDrivers(a, b, 'B');
    expect(bRes.drivers[0]!.label).toBeNull();
  });
});

function storedRow(drivers: BasisDriver[]): StoredExplanationRow {
  return {
    metric_id: '00000000-0000-0000-0000-000000000001',
    version_id: '00000000-0000-0000-0000-000000000002',
    cache_key: 'k',
    dimension: 'stage',
    dimension_class: 'B',
    delta_abs: '42',
    delta_pct: null,
    drivers,
    narrative: null,
    computed_at: new Date('2026-07-17T00:00:00.000Z'),
  };
}

describe('shapeForRead read-time leak safety (absent-asker fallback)', () => {
  const raw: BasisDriver[] = [
    { dimension_value: 'e1', label: null, contribution_abs: 30, contribution_pct: 71 },
    { dimension_value: 'e2', label: null, contribution_abs: 12, contribution_pct: 29 },
  ];

  it('Class A is served as-is (per-value labels + amounts)', () => {
    const out = shapeForRead(storedRow(raw), 'A');
    expect(out.drivers).toHaveLength(2);
    expect(out.drivers.map((d) => d.dimension_value)).toEqual(['e1', 'e2']);
  });

  it('Class B collapses every entity into one "Other (all N hidden)" bucket', () => {
    const out = shapeForRead(storedRow(raw), 'B');
    expect(out.drivers).toHaveLength(1);
    const other = out.drivers[0]!;
    expect(other.is_other).toBe(true);
    expect(other.hidden_count).toBe(2);
    expect(other.label).toBe('Other (all 2 hidden)');
    // The bucket carries only the aggregate; no per-entity amount is exposed.
    expect(other.contribution_abs).toBe(42);
  });

  it('correlation is always empty at read time (per-viewer, added by caller)', () => {
    const out = shapeForRead(storedRow(raw), 'B');
    expect(out.correlation).toEqual([]);
  });
});

describe('shapeClassBDrivers per-viewer resolution + k>=2 suppression', () => {
  const drivers: BasisDriver[] = [
    { dimension_value: 'a', label: null, contribution_abs: 50, contribution_pct: 50 },
    { dimension_value: 'b', label: null, contribution_abs: 30, contribution_pct: 30 },
    { dimension_value: 'c', label: null, contribution_abs: 20, contribution_pct: 20 },
  ];

  it('absent asker (empty visible set) hides everything in one bucket', () => {
    const out = shapeClassBDrivers(drivers, []);
    expect(out).toHaveLength(1);
    expect(out[0]!.is_other).toBe(true);
    expect(out[0]!.hidden_count).toBe(3);
    expect(out[0]!.label).toBe('Other (all 3 hidden)');
  });

  it('serves visible rows with labels and hides the rest when >=2 remain hidden', () => {
    const out = shapeClassBDrivers(drivers, ['a']); // b,c hidden (2)
    const served = out.filter((d) => !d.is_other);
    const other = out.find((d) => d.is_other)!;
    expect(served.map((d) => d.dimension_value)).toEqual(['a']);
    expect(served[0]!.label).toBe('a');
    expect(other.hidden_count).toBe(2);
    expect(other.contribution_abs).toBe(50); // 30 + 20
  });

  it('k>=2: a single hidden row alongside served rows is suppressed by demoting a served row', () => {
    // Asker can see a and b; only c would be hidden (N=1) -> complementary
    // disclosure. The smallest served row (b=30) is demoted so >=2 are hidden.
    const out = shapeClassBDrivers(drivers, ['a', 'b']);
    const other = out.find((d) => d.is_other)!;
    expect(other.hidden_count).toBeGreaterThanOrEqual(2);
    // c's exact amount (20) must NOT be recoverable: the Other bucket aggregates
    // b+c (50), not c alone.
    expect(other.contribution_abs).toBe(50);
    const servedValues = out.filter((d) => !d.is_other).map((d) => d.dimension_value);
    expect(servedValues).toEqual(['a']); // b was demoted into Other
  });

  it('all visible: every row served with a label, no Other bucket', () => {
    const out = shapeClassBDrivers(drivers, ['a', 'b', 'c']);
    expect(out.every((d) => !d.is_other)).toBe(true);
    expect(out).toHaveLength(3);
  });

  it('single entity, none visible: the lone bucket equals the (public) delta and is safe', () => {
    const one: BasisDriver[] = [
      { dimension_value: 'solo', label: null, contribution_abs: 42, contribution_pct: 100 },
    ];
    const out = shapeClassBDrivers(one, []);
    expect(out).toHaveLength(1);
    expect(out[0]!.hidden_count).toBe(1);
    expect(out[0]!.contribution_abs).toBe(42);
  });
});

// Executable spec-of-record for the one invariant still unimplemented.
describe('deferred spec-of-record (not yet implemented)', () => {
  // Registration-time guard: a label column sourced from a restricted entity must
  // not be registerable as Class A.
  it.todo('registration rejects a restricted-entity label column as Class A');
});
