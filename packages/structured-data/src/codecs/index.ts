import type { DecodeResult, Dialect, Format } from '../types.js';
import { decodeJson, encodeJson } from './json.js';
import { decodeJsonl, encodeJsonl } from './jsonl.js';
import { decodeCsv, encodeCsv } from './csv.js';
import { decodeYaml, encodeYaml } from './yaml.js';

export * from './json.js';
export * from './jsonl.js';
export * from './csv.js';
export * from './yaml.js';

/** Decode bytes into a plain JS value + a replayable dialect, by format. */
export function decode(text: string, format: Format): DecodeResult {
  switch (format) {
    case 'json':
      return decodeJson(text);
    case 'jsonl':
      return decodeJsonl(text);
    case 'csv':
      return decodeCsv(text, 'csv');
    case 'tsv':
      return decodeCsv(text, 'tsv');
    case 'yaml':
      return decodeYaml(text);
    default: {
      const _exhaustive: never = format;
      throw new Error(`unknown format: ${_exhaustive as string}`);
    }
  }
}

/** Serialize a plain JS value back to bytes using the captured dialect. */
export function encode(data: unknown, dialect: Dialect): string {
  switch (dialect.format) {
    case 'json':
      return encodeJson(data, dialect);
    case 'jsonl':
      return encodeJsonl(data as unknown[], dialect);
    case 'csv':
    case 'tsv':
      return encodeCsv(data as Record<string, unknown>[], dialect);
    case 'yaml':
      return encodeYaml(data);
    default: {
      const _exhaustive: never = dialect;
      throw new Error(`unknown dialect: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
