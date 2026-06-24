import type { Format, Shape } from './types.js';

export interface ShapeResult {
  shape: Shape;
  /** Present when shape === 'record'. */
  rows?: Record<string, unknown>[];
  /** Present when shape === 'record'; first-seen column order. */
  columns?: string[];
}

const SYNTHETIC_VALUE_COLUMN = 'value';

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Ordered union of keys across rows, first-seen order preserved. */
function unionColumns(rows: Record<string, unknown>[]): string[] {
  const seen = new Set<string>();
  const cols: string[] = [];
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (!seen.has(k)) {
        seen.add(k);
        cols.push(k);
      }
    }
  }
  return cols;
}

/**
 * Decide the render shape from a parsed value (not the extension). CSV/TSV/JSONL
 * are always records. JSON depends on structure: an array of mostly-uniform
 * objects is a grid; an array of scalars becomes a one-column grid; a single
 * nested object (or a ragged/deeply-nested array below the uniformity threshold)
 * is a tree. (Bin_Master_Design_Document.md §10.1.)
 *
 * @param uniformityThreshold mean key-coverage at/above which an array of objects
 *   renders as a grid (default 0.7).
 */
export function detectShape(
  data: unknown,
  format: Format,
  uniformityThreshold = 0.7,
): ShapeResult {
  if (format === 'csv' || format === 'tsv' || format === 'jsonl') {
    const rows = (Array.isArray(data) ? data : []).filter(isPlainObject);
    return { shape: 'record', rows, columns: unionColumns(rows) };
  }

  // JSON / YAML value.
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return { shape: 'record', rows: [], columns: [] };
    }
    const objectRows = data.filter(isPlainObject);
    const allObjects = objectRows.length === data.length;

    if (allObjects) {
      const cols = unionColumns(objectRows);
      const coverage =
        cols.length === 0
          ? 1
          : objectRows.reduce(
              (acc, row) => acc + Object.keys(row).length / cols.length,
              0,
            ) / objectRows.length;
      // Nested values push toward tree even when uniform-ish.
      const hasNested = objectRows.some((row) =>
        Object.values(row).some((v) => isPlainObject(v) || Array.isArray(v)),
      );
      if (coverage >= uniformityThreshold && !hasNested) {
        return { shape: 'record', rows: objectRows, columns: cols };
      }
      return { shape: 'tree' };
    }

    const allScalars = data.every((v) => !isPlainObject(v) && !Array.isArray(v));
    if (allScalars) {
      // Array of scalars -> one synthesized "value" column.
      return {
        shape: 'record',
        rows: data.map((v) => ({ [SYNTHETIC_VALUE_COLUMN]: v })),
        columns: [SYNTHETIC_VALUE_COLUMN],
      };
    }

    // Ragged / mixed array -> tree.
    return { shape: 'tree' };
  }

  // Single object or scalar -> tree.
  return { shape: 'tree' };
}
