import { neutralizeCsvValue } from '@bigbluebam/shared';
import type { CsvRow } from './csv-parse';

// One failed/warned row for the downloadable error report (Phase 2, §5.4.7).
export interface ErrorReportEntry {
  row: number; // 1-based row number from the import
  reason: string; // failure or warning message
  data?: CsvRow; // original row cells (optional — warnings carry the offending cell only)
}

// Quote a single CSV field per RFC 4180: wrap in quotes when it contains a
// comma, quote, or newline; double embedded quotes.
function csvCell(value: string): string {
  const v = neutralizeCsvValue(value);
  if (/[",\n\r]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/**
 * Serialize failed/warned rows to a CSV string, client-side. Columns:
 * `row, reason, <original headers…>`. When entries carry original row data, the
 * union of their keys (in `headers` order when supplied) becomes the data
 * columns; otherwise only `row` and `reason` are emitted.
 */
export function buildErrorReportCsv(
  entries: ErrorReportEntry[],
  headers: string[] = [],
): string {
  // Determine data columns: prefer the provided header order, else the union of
  // keys observed across entries.
  const dataCols =
    headers.length > 0
      ? headers
      : [...new Set(entries.flatMap((e) => (e.data ? Object.keys(e.data) : [])))];

  const headerRow = ['row', 'reason', ...dataCols].map(csvCell).join(',');
  const rows = entries.map((e) => {
    const cells = [String(e.row), e.reason, ...dataCols.map((c) => e.data?.[c] ?? '')];
    return cells.map(csvCell).join(',');
  });
  return [headerRow, ...rows].join('\r\n');
}

/**
 * Trigger a client-side download of the error report. No-op when there are no
 * entries. Uses a Blob + object URL; safe in jsdom guards (skips when document
 * is unavailable).
 */
export function downloadErrorReport(
  entries: ErrorReportEntry[],
  headers: string[] = [],
  filename = 'import-errors.csv',
): void {
  if (entries.length === 0) return;
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const csv = buildErrorReportCsv(entries, headers);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Parse the import service's flat error strings (e.g. "Row 3: missing title" or
 * "Row 5 [QA Cost]: not a number ("abc")") back into structured entries so a
 * report can be built from the commit result. Rows that don't match the
 * "Row N" prefix get row 0.
 */
export function parseImportErrors(errors: string[]): ErrorReportEntry[] {
  return errors.map((message) => {
    const m = message.match(/^Row (\d+)\b/);
    return { row: m ? Number(m[1]) : 0, reason: message };
  });
}
