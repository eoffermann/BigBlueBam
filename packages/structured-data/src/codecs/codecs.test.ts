import { describe, it, expect } from 'vitest';
import { decode, encode } from './index.js';

describe('JSON codec round-trip', () => {
  it('preserves 2-space pretty indent + trailing newline byte-stable', () => {
    const src = '{\n  "a": 1,\n  "b": "x"\n}\n';
    const { data, dialect } = decode(src, 'json');
    expect(data).toEqual({ a: 1, b: 'x' });
    expect(encode(data, dialect)).toBe(src);
  });

  it('preserves tab indent', () => {
    const src = '{\n\t"a": 1\n}';
    const { data, dialect } = decode(src, 'json');
    expect(encode(data, dialect)).toBe(src);
  });

  it('round-trips minified JSON (no trailing newline)', () => {
    const src = '{"a":1,"b":[1,2,3]}';
    const { data, dialect } = decode(src, 'json');
    expect(encode(data, dialect)).toBe(src);
  });

  it('preserves key order', () => {
    const src = '{\n  "z": 1,\n  "a": 2,\n  "m": 3\n}';
    const { data, dialect } = decode(src, 'json');
    expect(Object.keys(data as object)).toEqual(['z', 'a', 'm']);
    expect(encode(data, dialect)).toBe(src);
  });
});

describe('JSONL codec round-trip', () => {
  it('preserves one-object-per-line and trailing newline', () => {
    const src = '{"id":1,"name":"a"}\n{"id":2,"name":"b"}\n';
    const { data, dialect } = decode(src, 'jsonl');
    expect(data).toEqual([
      { id: 1, name: 'a' },
      { id: 2, name: 'b' },
    ]);
    expect(encode(data, dialect)).toBe(src);
  });

  it('round-trips without a trailing newline', () => {
    const src = '{"id":1}\n{"id":2}';
    const { data, dialect } = decode(src, 'jsonl');
    expect(encode(data, dialect)).toBe(src);
  });
});

describe('CSV/TSV codec round-trip', () => {
  it('round-trips a clean comma CSV byte-stable', () => {
    const src = 'id,name,active\n1,Alice,true\n2,Bob,false';
    const { data, dialect } = decode(src, 'csv');
    expect(data).toEqual([
      { id: '1', name: 'Alice', active: 'true' },
      { id: '2', name: 'Bob', active: 'false' },
    ]);
    expect(encode(data, dialect)).toBe(src);
  });

  it('preserves quoting of fields containing the delimiter', () => {
    const src = 'id,note\n1,"hello, world"\n2,plain';
    const { data, dialect } = decode(src, 'csv');
    expect((data as Record<string, string>[])[0]!.note).toBe('hello, world');
    // structural round-trip: re-parse equals
    const reparsed = decode(encode(data, dialect), 'csv').data;
    expect(reparsed).toEqual(data);
  });

  it('detects and preserves the tab delimiter for TSV', () => {
    const src = 'id\tname\n1\tAlice\n2\tBob';
    const { data, dialect } = decode(src, 'tsv');
    expect(dialect).toMatchObject({ format: 'tsv', delimiter: '\t' });
    expect(data).toEqual([
      { id: '1', name: 'Alice' },
      { id: '2', name: 'Bob' },
    ]);
    expect(encode(data, dialect)).toBe(src);
  });

  it('preserves column order', () => {
    const src = 'z,a,m\n1,2,3';
    const { dialect } = decode(src, 'csv');
    expect((dialect as { columns: string[] }).columns).toEqual(['z', 'a', 'm']);
  });
});
