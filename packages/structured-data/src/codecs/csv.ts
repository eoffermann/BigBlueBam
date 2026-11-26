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

/**
 * CSV/TSV as a plain grid of strings (no header interpretation), row positions preserved: a
 * blank line stays an empty row, so row N of the grid is line N of the file. A leading byte
 * order mark is dropped and a trailing empty line is not a row. Used where the caller decides
 * which row is the header (questionnaire column mapping) and writes answers back by position.
 */
export function decodeCsvGrid(text: string, format: Format = 'csv'): string[][] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const parsed = Papa.parse<string[]>(clean, {
    header: false,
    skipEmptyLines: false,
    dynamicTyping: false,
    delimiter: format === 'tsv' ? '\t' : undefined,
  });
  const rows = parsed.data.map((r) => (Array.isArray(r) ? r.map((c) => (c == null ? '' : String(c))) : []));
  while (rows.length > 0 && (rows[rows.length - 1] as string[]).every((c) => c === '')) rows.pop();
  return rows.map((r) => (r.length === 1 && r[0] === '' ? [] : r));
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
