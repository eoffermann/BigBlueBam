import { describe, it, expect } from 'vitest';
import { detectShape } from './shape.js';

describe('detectShape', () => {
  it('CSV is always a record', () => {
    const r = detectShape([{ a: '1' }, { a: '2' }], 'csv');
    expect(r.shape).toBe('record');
    expect(r.columns).toEqual(['a']);
  });

  it('JSONL is always a record', () => {
    const r = detectShape([{ a: 1 }, { b: 2 }], 'jsonl');
    expect(r.shape).toBe('record');
    expect(r.columns).toEqual(['a', 'b']);
  });

  it('JSON array of uniform flat objects -> record', () => {
    const r = detectShape([{ id: 1, n: 'a' }, { id: 2, n: 'b' }], 'json');
    expect(r.shape).toBe('record');
    expect(r.columns).toEqual(['id', 'n']);
    expect(r.rows).toHaveLength(2);
  });

  it('JSON array of scalars -> record with a synthesized value column', () => {
    const r = detectShape([1, 2, 3], 'json');
    expect(r.shape).toBe('record');
    expect(r.columns).toEqual(['value']);
    expect(r.rows).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
  });

  it('JSON single nested object -> tree', () => {
    const r = detectShape({ a: { b: 1 } }, 'json');
    expect(r.shape).toBe('tree');
  });

  it('JSON array of objects with nested values -> tree', () => {
    const r = detectShape([{ id: 1, meta: { x: 1 } }], 'json');
    expect(r.shape).toBe('tree');
  });

  it('JSON ragged array below the uniformity threshold -> tree', () => {
    const rows = [
      { a: 1, b: 2, c: 3, d: 4 },
      { a: 1 },
      { e: 9 },
    ];
    const r = detectShape(rows, 'json');
    expect(r.shape).toBe('tree');
  });

  it('JSON mixed scalar/object array -> tree', () => {
    const r = detectShape([1, { a: 1 }], 'json');
    expect(r.shape).toBe('tree');
  });

  it('empty JSON array -> empty record', () => {
    const r = detectShape([], 'json');
    expect(r.shape).toBe('record');
    expect(r.rows).toEqual([]);
  });
});
