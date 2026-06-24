// Core types for the structured-data layer shared by bin-api, the worker, and the
// /bin/ SPA. A "codec" turns bytes <-> a plain JS value plus a captured dialect;
// shape detection + inference are format-agnostic and run on that plain value.
// (See Bin_Master_Design_Document.md §10.)

/** The two render shapes a parsed structure collapses into. */
export type Shape = 'record' | 'tree';

/** Serialization formats Bin's structured editor opens. */
export type Format = 'csv' | 'tsv' | 'json' | 'jsonl' | 'yaml';

/** Per-format serialization details captured at decode time and replayed at
 *  encode time so a round trip preserves the original's surface form. */
export interface CsvDialect {
  delimiter: string;
  /** Quote character papaparse used (almost always `"`). */
  quoteChar: string;
  /** Row separator detected in the source. */
  newline: '\n' | '\r\n';
  /** Whether the first row is a header. */
  hasHeader: boolean;
  /** Header/column order, preserved across edits. */
  columns: string[];
}

export interface JsonDialect {
  /** Indent unit captured from the source: a space count, or '\t', or 0 (minified). */
  indent: number | '\t';
  /** Whether the file ended with a trailing newline. */
  trailingNewline: boolean;
}

export interface JsonlDialect {
  newline: '\n' | '\r\n';
  trailingNewline: boolean;
}

export type Dialect =
  | ({ format: 'csv' | 'tsv' } & CsvDialect)
  | ({ format: 'json' } & JsonDialect)
  | ({ format: 'jsonl' } & JsonlDialect)
  | { format: 'yaml' };

/** Result of decoding bytes into a plain JS value + the dialect to replay. */
export interface DecodeResult {
  format: Format;
  /** The parsed plain JS value (array for record-ish, object/array for tree). */
  data: unknown;
  dialect: Dialect;
}

/** Inference output per field. */
export type InferredType =
  | 'string'
  | 'integer'
  | 'number'
  | 'boolean'
  | 'date'
  | 'datetime'
  | 'enum';

export interface InferredField {
  key: string;
  type: InferredType;
  nullable: boolean;
  /** Set when type === 'enum'. */
  enumValues?: string[];
  /** True for string fields whose sampled values are long or contain newlines. */
  longtext?: boolean;
}

export interface InferredSchema {
  fields: InferredField[];
}

/** A fully parsed asset: format + dialect + detected shape, plus the record
 *  projection (rows + columns) when shape === 'record'. */
export interface ParsedAsset {
  format: Format;
  dialect: Dialect;
  shape: Shape;
  data: unknown;
  /** Present when shape === 'record'. */
  rows?: Record<string, unknown>[];
  /** Present when shape === 'record'; column order. */
  columns?: string[];
}
