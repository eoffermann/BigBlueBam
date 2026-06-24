import * as Y from 'yjs';
import type { ParsedAsset, Shape } from './types.js';

/** Row-identity field carried in each record-row Y.Map: a stable anchor for
 *  comments/diffs across reorders, never surfaced as data (master §10.4). */
export const RID = '__rid';

function newId(): string {
  // Both node and modern browsers expose crypto.randomUUID.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `r-${Math.random().toString(36).slice(2)}`;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Build a fresh (detached) Y type tree for a plain value (tree shape). */
function buildNode(value: unknown): unknown {
  if (Array.isArray(value)) {
    const arr = new Y.Array();
    arr.push(value.map((child) => buildNode(child)));
    return arr;
  }
  if (isPlainObject(value)) {
    const map = new Y.Map();
    for (const [k, v] of Object.entries(value)) map.set(k, buildNode(v));
    return map;
  }
  return value;
}

/**
 * Build a Y.Doc from a parsed asset. Record shape: a `rows` Y.Array of per-row
 * Y.Maps (cell = LWW register), a `meta` Y.Map carrying column order. Tree shape:
 * a recursive Y.Map/Y.Array under `root.value`. (master §10.4.)
 */
export function buildYDoc(parsed: ParsedAsset): Y.Doc {
  const doc = new Y.Doc();
  if (parsed.shape === 'record') {
    const columns = parsed.columns ?? [];
    const meta = doc.getMap('meta');
    meta.set('shape', 'record');
    const cols = new Y.Array<string>();
    cols.push(columns);
    meta.set('columns', cols);
    const rows = doc.getArray<Y.Map<unknown>>('rows');
    const yrows = (parsed.rows ?? []).map((row) => {
      const m = new Y.Map<unknown>();
      m.set(RID, newId());
      for (const col of columns) m.set(col, row[col] ?? null);
      return m;
    });
    rows.push(yrows);
  } else {
    const root = doc.getMap('root');
    root.set('shape', 'tree');
    root.set('value', buildNode(parsed.data));
  }
  return doc;
}

/**
 * Serialize a Y.Doc back to the plain JS value to hand to a codec's encode().
 * Record shape returns the array of row objects in column order (RID stripped);
 * tree shape returns the reconstructed object/array.
 */
export function serializeYDoc(doc: Y.Doc, shape: Shape): unknown {
  if (shape === 'record') {
    const meta = doc.getMap('meta');
    const cols = (meta.get('columns') as Y.Array<string> | undefined)?.toArray() ?? [];
    const rows = doc.getArray<Y.Map<unknown>>('rows');
    return rows.toArray().map((m) => {
      const obj: Record<string, unknown> = {};
      const keys = cols.length > 0 ? cols : [...m.keys()].filter((k) => k !== RID);
      for (const key of keys) {
        if (key === RID) continue;
        const v = m.get(key);
        obj[key] = v instanceof Y.AbstractType ? (v as { toJSON: () => unknown }).toJSON() : v;
      }
      return obj;
    });
  }
  const root = doc.getMap('root');
  const value = root.get('value');
  return value instanceof Y.AbstractType ? (value as { toJSON: () => unknown }).toJSON() : value;
}
