import { describe, expect, it } from 'vitest';
import { layoutZoneIds } from '../src/services/floor-layout.service.js';

describe('layoutZoneIds', () => {
  it('returns the zone ids for a populated layout', () => {
    const ids = layoutZoneIds({
      zones: [{ id: 'zone-a' }, { id: 'zone-b', label: 'B' }],
    });
    expect(ids).not.toBeNull();
    expect([...ids!]).toEqual(['zone-a', 'zone-b']);
  });

  it('returns null for an empty/bootstrap layout (validation skipped)', () => {
    expect(layoutZoneIds({})).toBeNull();
    expect(layoutZoneIds(null)).toBeNull();
    expect(layoutZoneIds(undefined)).toBeNull();
    expect(layoutZoneIds({ zones: [] })).toBeNull();
  });

  it('returns null when zones exist but carry no usable string ids', () => {
    expect(layoutZoneIds({ zones: [{ id: 42 }, { label: 'no id' }] })).toBeNull();
  });

  it('ignores malformed zone entries but keeps valid ids', () => {
    const ids = layoutZoneIds({ zones: [null, { id: 'zone-a' }, { id: '' }, 7] });
    expect([...ids!]).toEqual(['zone-a']);
  });

  it('is not fooled by non-array zones', () => {
    expect(layoutZoneIds({ zones: 'zone-a' })).toBeNull();
    expect(layoutZoneIds({ zones: { id: 'zone-a' } })).toBeNull();
  });
});
