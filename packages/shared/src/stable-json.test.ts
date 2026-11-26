import { describe, expect, it } from 'vitest';
import { stableStringify } from './stable-json.js';

// #275: canonical JSON for cache keys.
describe('stableStringify', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 2 } })).toBe('{"a":{"c":2,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('keeps nested values, unlike a JSON.stringify array replacer', () => {
    const cfg = { measures: [{ field: 'amount' }] };
    expect(JSON.stringify(cfg, Object.keys(cfg).sort())).toBe('{"measures":[{}]}');
    expect(stableStringify(cfg)).toBe('{"measures":[{"field":"amount"}]}');
  });

  it('drops undefined members like JSON does, and maps undefined array slots to null', () => {
    expect(stableStringify({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
    expect(stableStringify(new Date('2026-01-01T00:00:00Z'))).toBe('"2026-01-01T00:00:00.000Z"');
  });
});
