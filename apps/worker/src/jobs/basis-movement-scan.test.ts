import { describe, it, expect } from 'vitest';
import { breached } from './basis-movement-scan.job.js';

// Spec section 9: the breach predicate drives metric.threshold_breached. A wrong
// direction either misses a real breach or fires a false alert, so pin every
// comparison. `breached` returns true when the target is VIOLATED.
describe('basis movement-scan breach predicate', () => {
  it('gte: breached when value falls below the floor', () => {
    const t = { value: 100, comparison: 'gte' };
    expect(breached(99, t)).toBe(true);
    expect(breached(100, t)).toBe(false); // exactly meeting the floor is OK
    expect(breached(101, t)).toBe(false);
  });

  it('gt: breached at or below the bound', () => {
    const t = { value: 100, comparison: 'gt' };
    expect(breached(100, t)).toBe(true); // must be strictly greater
    expect(breached(101, t)).toBe(false);
    expect(breached(99, t)).toBe(true);
  });

  it('lte: breached when value rises above the ceiling', () => {
    const t = { value: 50, comparison: 'lte' };
    expect(breached(51, t)).toBe(true);
    expect(breached(50, t)).toBe(false); // exactly meeting the ceiling is OK
    expect(breached(49, t)).toBe(false);
  });

  it('lt: breached at or above the bound', () => {
    const t = { value: 50, comparison: 'lt' };
    expect(breached(50, t)).toBe(true); // must be strictly less
    expect(breached(49, t)).toBe(false);
    expect(breached(51, t)).toBe(true);
  });

  it('unknown comparison never breaches (fail safe, no false alerts)', () => {
    expect(breached(0, { value: 100, comparison: 'between' })).toBe(false);
  });
});
