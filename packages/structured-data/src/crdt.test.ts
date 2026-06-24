import { describe, it, expect } from 'vitest';
import * as Y from 'yjs';
import { buildYDoc, serializeYDoc, RID } from './crdt.js';
import { parseAsset } from './index.js';
import { encode } from './codecs/index.js';

/** Full file -> Y.Doc -> file round trip for a format. */
function roundTrip(text: string, format: Parameters<typeof parseAsset>[1]): string {
  const parsed = parseAsset(text, format);
  const doc = buildYDoc(parsed);
  const value = serializeYDoc(doc, parsed.shape);
  return encode(value, parsed.dialect);
}

describe('CRDT round trip — record shape', () => {
  it('CSV survives file -> Y.Doc -> file byte-stable', () => {
    const src = 'id,name,active\n1,Alice,true\n2,Bob,false';
    expect(roundTrip(src, 'csv')).toBe(src);
  });

  it('JSONL survives round trip', () => {
    const src = '{"id":1,"name":"a"}\n{"id":2,"name":"b"}\n';
    expect(roundTrip(src, 'jsonl')).toBe(src);
  });

  it('JSON array-of-objects survives round trip', () => {
    const src = '[\n  {\n    "id": 1\n  },\n  {\n    "id": 2\n  }\n]';
    // structural equality (indent of nested array elements is codec-dependent)
    const out = roundTrip(src, 'json');
    expect(JSON.parse(out)).toEqual(JSON.parse(src));
  });

  it('strips the row-identity field from serialized output', () => {
    const parsed = parseAsset('id\n1\n2', 'csv');
    const doc = buildYDoc(parsed);
    const rows = serializeYDoc(doc, 'record') as Record<string, unknown>[];
    expect(rows.every((r) => !(RID in r))).toBe(true);
  });
});

describe('CRDT round trip — tree shape', () => {
  it('nested JSON object survives round trip', () => {
    const src = '{\n  "a": {\n    "b": 1,\n    "c": [1, 2, 3]\n  }\n}';
    expect(JSON.parse(roundTrip(src, 'json'))).toEqual(JSON.parse(src));
  });
});

describe('CRDT merge semantics', () => {
  it('a cell edit is a last-writer-wins register (concurrent edits converge)', () => {
    const parsed = parseAsset('id,name\n1,Alice', 'csv');
    const a = buildYDoc(parsed);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a)); // clone

    // Two replicas edit the same cell concurrently, then exchange updates.
    (a.getArray('rows').get(0) as Y.Map<unknown>).set('name', 'Skipper');
    (b.getArray('rows').get(0) as Y.Map<unknown>).set('name', 'Gilligan');
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    const an = (a.getArray('rows').get(0) as Y.Map<unknown>).get('name');
    const bn = (b.getArray('rows').get(0) as Y.Map<unknown>).get('name');
    expect(an).toBe(bn); // converged deterministically
  });

  it('concurrent row inserts both survive the merge', () => {
    const parsed = parseAsset('id\n1', 'csv');
    const a = buildYDoc(parsed);
    const b = new Y.Doc();
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    const mkRow = (v: string) => {
      const m = new Y.Map<unknown>();
      m.set('id', v);
      return m;
    };
    a.getArray<Y.Map<unknown>>('rows').push([mkRow('2')]);
    b.getArray<Y.Map<unknown>>('rows').push([mkRow('3')]);
    Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
    Y.applyUpdate(b, Y.encodeStateAsUpdate(a));

    expect(a.getArray('rows').length).toBe(3);
    expect(b.getArray('rows').length).toBe(3);
  });
});
