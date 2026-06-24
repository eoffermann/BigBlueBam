import { z } from 'zod';
import type { InferredField, InferredSchema, InferredType } from './types.js';

const LONGTEXT_LEN = 120;
const ENUM_MAX_DISTINCT = 12;
const ENUM_MIN_ROWS = 8;

const RE_INT = /^-?\d+$/;
const RE_NUM = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;
const RE_BOOL = /^(true|false)$/i;
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

function isEmpty(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

/** Normalize a sampled cell to the string the source would have held. */
function asStr(v: unknown): string {
  return typeof v === 'string' ? v : String(v);
}

function classify(values: string[]): { type: InferredType; enumValues?: string[]; longtext: boolean } {
  const longtext = values.some((v) => v.length > LONGTEXT_LEN || v.includes('\n'));
  const all = (re: RegExp) => values.length > 0 && values.every((v) => re.test(v));

  if (all(RE_INT)) return { type: 'integer', longtext: false };
  if (all(RE_NUM)) return { type: 'number', longtext: false };
  if (all(RE_BOOL)) return { type: 'boolean', longtext: false };
  if (all(RE_DATETIME)) return { type: 'datetime', longtext: false };
  if (all(RE_DATE)) return { type: 'date', longtext: false };

  const distinct = [...new Set(values)];
  if (
    !longtext &&
    values.length >= ENUM_MIN_ROWS &&
    distinct.length > 1 &&
    distinct.length <= ENUM_MAX_DISTINCT &&
    distinct.length <= Math.max(1, Math.floor(values.length / 2))
  ) {
    return { type: 'enum', enumValues: distinct.sort(), longtext: false };
  }

  return { type: 'string', longtext };
}

/**
 * Infer a per-field schema from a sample of record rows. Always produces a usable
 * schema so the editor is never blocked on a missing one. Enum detection (a
 * low-cardinality string column) is what makes the editor feel finished.
 * (Bin_Master_Design_Document.md §10.2.)
 */
export function inferSchema(
  rows: Record<string, unknown>[],
  columns: string[],
  sampleSize = 200,
): InferredSchema {
  const sample = rows.slice(0, sampleSize);
  const fields: InferredField[] = columns.map((key) => {
    const raw = sample.map((r) => r[key]);
    const nullable = raw.some(isEmpty);
    const present = raw.filter((v) => !isEmpty(v)).map(asStr);
    if (present.length === 0) {
      return { key, type: 'string', nullable: true };
    }
    const { type, enumValues, longtext } = classify(present);
    const field: InferredField = { key, type, nullable };
    if (enumValues) field.enumValues = enumValues;
    if (longtext) field.longtext = true;
    return field;
  });
  return { fields };
}

/** Bridge an inferred field to a Zod type. */
function fieldToZod(field: InferredField): z.ZodTypeAny {
  let base: z.ZodTypeAny;
  switch (field.type) {
    case 'integer':
      base = z.coerce.number().int();
      break;
    case 'number':
      base = z.coerce.number();
      break;
    case 'boolean':
      base = z.coerce.boolean();
      break;
    case 'date':
    case 'datetime':
      base = z.string(); // kept as ISO string; widget is a date picker
      break;
    case 'enum':
      base =
        field.enumValues && field.enumValues.length > 0
          ? z.enum(field.enumValues as [string, ...string[]])
          : z.string();
      break;
    default:
      base = z.string();
  }
  return field.nullable ? base.nullable() : base;
}

/** Build a Zod object schema for record rows from an inferred schema. The suite's
 *  validation spine is Zod (REST routes, storage configs), so the editor widgets,
 *  save-time validation, and portable JSON Schema export all derive from this. */
export function inferredToZod(schema: InferredSchema): z.ZodObject<z.ZodRawShape> {
  const shape: z.ZodRawShape = {};
  for (const field of schema.fields) {
    shape[field.key] = fieldToZod(field);
  }
  return z.object(shape);
}
