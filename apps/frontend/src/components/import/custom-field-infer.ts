import type { CsvRow } from './csv-parse';

// Custom-field types the platform supports (mirror of the API enum).
export type CustomFieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'select'
  | 'multi_select'
  | 'checkbox'
  | 'url';

// One entry of the wire `custom_field_mapping[]` (Phase 2, §5.2 / G3).
export interface CustomFieldMappingWire {
  column: string;
  field_name: string;
  field_type: CustomFieldType;
  create_if_missing: boolean;
}

const NUMBER_RE = /^[$]?-?\d{1,3}(,\d{3})*(\.\d+)?%?$|^[$]?-?\d+(\.\d+)?%?$/;
const ISO_DATE_RE = /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/;
const US_DATE_RE = /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}$/;
const CHECKBOX_TRUTHY = new Set(['true', 'yes', 'x', '1', 'y', 't']);
const CHECKBOX_FALSY = new Set(['false', 'no', '0', 'n', 'f']);

function isNumberish(v: string): boolean {
  return NUMBER_RE.test(v.trim());
}

function isDateish(v: string): boolean {
  const t = v.trim();
  if (ISO_DATE_RE.test(t) || US_DATE_RE.test(t)) return true;
  // Word-y date fallback ("June 9, 2026"). Require a year-like token to avoid
  // matching plain words.
  if (/\d{4}/.test(t) && !Number.isNaN(Date.parse(t))) return true;
  return false;
}

function isCheckboxish(v: string): boolean {
  const t = v.trim().toLowerCase();
  return CHECKBOX_TRUTHY.has(t) || CHECKBOX_FALSY.has(t);
}

/**
 * Infer the most likely custom-field type for a column by sampling up to
 * `sampleLimit` non-empty cells (plan §5.4 / Phase-2 frontend).
 *
 * Order of precedence:
 *   - all numeric                  → number
 *   - all ISO/locale/word dates    → date
 *   - all TRUE/FALSE-ish           → checkbox
 *   - every cell has a comma AND
 *     low overall cardinality      → multi_select
 *   - ≤ 12 distinct repeated values → select
 *   - else                          → text
 *
 * Empty cells are ignored. An all-empty column infers `text`.
 */
export function inferCustomFieldType(
  rows: CsvRow[],
  column: string,
  sampleLimit = 200,
): CustomFieldType {
  const sample: string[] = [];
  for (const row of rows) {
    const v = (row[column] ?? '').trim();
    if (!v) continue;
    sample.push(v);
    if (sample.length >= sampleLimit) break;
  }
  if (sample.length === 0) return 'text';

  if (sample.every(isNumberish)) return 'number';
  if (sample.every(isDateish)) return 'date';
  if (sample.every(isCheckboxish)) return 'checkbox';

  // Cardinality of the full sample.
  const distinct = new Set(sample);

  // multi_select: every sampled cell holds a comma-separated list, and the union
  // of split tokens is low-cardinality.
  const everyHasComma = sample.every((v) => v.includes(','));
  if (everyHasComma) {
    const tokens = new Set<string>();
    for (const v of sample) {
      for (const part of v.split(',').map((p) => p.trim()).filter(Boolean)) {
        tokens.add(part);
      }
    }
    if (tokens.size > 0 && tokens.size <= 12) return 'multi_select';
  }

  // select: small distinct set that repeats (more cells than distinct values).
  if (distinct.size <= 12 && distinct.size < sample.length) return 'select';

  return 'text';
}

/**
 * Serialize the per-column custom-field configs into the wire
 * `custom_field_mapping[]`, for the columns currently mapped to a custom field.
 * Drops entries with a blank field name.
 */
export function serializeCustomFieldMappings(
  configs: CustomFieldConfig[],
): CustomFieldMappingWire[] {
  return configs
    .filter((c) => c.field_name.trim().length > 0)
    .map((c) => ({
      column: c.column,
      field_name: c.field_name.trim(),
      field_type: c.field_type,
      create_if_missing: c.create_if_missing,
    }));
}

// A column's custom-field mapping config, as edited in the wizard.
export interface CustomFieldConfig {
  column: string;
  field_name: string;
  field_type: CustomFieldType;
  // true → find-or-create the definition; false → only write to an existing one.
  create_if_missing: boolean;
}
