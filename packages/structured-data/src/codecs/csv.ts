import Papa from 'papaparse';
import type { CsvDialect, DecodeResult, Format } from '../types.js';

/**
 * CSV/TSV codec. papaparse handles quoting/escaping; we capture the dialect
 * (delimiter, quote char, newline, header presence, column order) so encode
 * replays the source's surface form. Header presence defaults to true (the
 * structured editor's common case); callers can override on the returned dialect.
 */
export function decodeCsv(text: string, format: Format = 'csv'): DecodeResult {
  const newline: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
  const forcedDelimiter = format === 'tsv' ? '\t' : undefined;
  const parsed = Papa.parse<Record<string, unknown>>(text, {
    header: true,
    skipEmptyLines: 'greedy',
    dynamicTyping: false, // keep raw strings; inference decides types
    delimiter: forcedDelimiter,
  });
  const delimiter = forcedDelimiter ?? parsed.meta.delimiter ?? ',';
  const columns = parsed.meta.fields ?? [];
  const dialect: CsvDialect = {
    delimiter,
    quoteChar: '"',
    newline,
    hasHeader: true,
    columns,
  };
  return {
    format,
    data: parsed.data,
    dialect: { format: format === 'tsv' ? 'tsv' : 'csv', ...dialect },
  };
}

export function encodeCsv(rows: Record<string, unknown>[], dialect: CsvDialect): string {
  return Papa.unparse(rows, {
    delimiter: dialect.delimiter,
    newline: dialect.newline,
    quoteChar: dialect.quoteChar,
    columns: dialect.columns.length > 0 ? dialect.columns : undefined,
    header: dialect.hasHeader,
  });
}
