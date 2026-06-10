import Papa from 'papaparse';

export interface CsvRow {
  [key: string]: string;
}

export interface ParsedCsv {
  headers: string[];
  rows: CsvRow[];
}

// Parse a CSV File with papaparse: worker + streaming mode, header row,
// skipEmptyLines, BOM + delimiter auto-detect. Returns a normalized sheet
// (see normalizeSheet) so callers never see leading blank columns / rows.
export function parseCsvFile(file: File): Promise<ParsedCsv> {
  return new Promise((resolve, reject) => {
    const collected: Record<string, unknown>[] = [];
    let headers: string[] = [];
    Papa.parse<Record<string, unknown>>(file, {
      header: true,
      skipEmptyLines: 'greedy',
      worker: true,
      // delimiter '' => papaparse auto-detects (comma, tab, semicolon, …).
      // NOTE: transformHeader is intentionally omitted — papaparse drops
      // non-(step/chunk/complete/error) callbacks when worker:true postMessages
      // the config, so it would be dead code. Header trim + BOM strip happen in
      // normalizeSheet instead, which always runs.
      delimiter: '',
      step: (results) => {
        if (headers.length === 0 && results.meta.fields) {
          headers = results.meta.fields;
        }
        collected.push(results.data);
      },
      complete: () => {
        const rows: CsvRow[] = collected.map((raw) => {
          const row: CsvRow = {};
          for (const h of headers) {
            const v = raw[h];
            row[h] = v == null ? '' : String(v);
          }
          return row;
        });
        resolve(normalizeSheet({ headers, rows }));
      },
      error: (err) => reject(err),
    });
  });
}

// Normalize a parsed sheet (plan 5.4.2):
//  - de-dupe repeated headers as "Name (2)", "Name (3)", …
//  - drop columns whose header is empty AND every cell is empty
//  - drop fully-empty rows
//  - trim headers + strip a leading UTF-8 BOM (papaparse exposes it on the
//    first header in worker mode, where transformHeader is unavailable)
export function normalizeSheet({ headers, rows }: ParsedCsv): ParsedCsv {
  // De-dupe headers, remapping each row's keys to the de-duped header so cell
  // lookups stay aligned. papaparse already overwrites duplicate keys in the
  // row object, so we can only recover the first occurrence's values; we keep
  // distinct dropdown entries by suffixing.
  const seen = new Map<string, number>();
  const dedupedHeaders: string[] = [];
  for (const h of headers) {
    const trimmed = h.replace(/^﻿/, '').trim();
    const prior = seen.get(trimmed);
    if (prior === undefined) {
      seen.set(trimmed, 1);
      dedupedHeaders.push(trimmed);
    } else {
      const next = prior + 1;
      seen.set(trimmed, next);
      dedupedHeaders.push(`${trimmed} (${next})`);
    }
  }

  // Rebuild rows under the de-duped header names. Where a header was renamed
  // because of a collision, the underlying papaparse row only holds one value
  // for the original key, so the renamed column inherits that same value.
  const remappedRows: CsvRow[] = rows.map((row) => {
    const out: CsvRow = {};
    for (let idx = 0; idx < headers.length; idx++) {
      const orig = headers[idx] ?? '';
      const deduped = dedupedHeaders[idx] ?? orig;
      out[deduped] = row[orig] ?? '';
    }
    return out;
  });

  // Determine which columns are entirely empty (empty header AND all cells empty).
  const keptHeaders = dedupedHeaders.filter((h, idx) => {
    const origHeaderEmpty = (headers[idx] ?? '').trim() === '';
    if (!origHeaderEmpty) return true;
    const anyCell = remappedRows.some((r) => (r[h] ?? '').trim() !== '');
    return anyCell;
  });

  // Drop fully-empty rows; project each kept row onto kept headers only.
  const keptRows: CsvRow[] = [];
  for (const row of remappedRows) {
    const hasContent = keptHeaders.some((h) => (row[h] ?? '').trim() !== '');
    if (!hasContent) continue;
    const projected: CsvRow = {};
    for (const h of keptHeaders) projected[h] = row[h] ?? '';
    keptRows.push(projected);
  }

  return { headers: keptHeaders, rows: keptRows };
}

// Scan a column across all rows and return distinct non-empty trimmed values
// with occurrence counts, sorted by descending count then value.
export function distinctColumnValues(
  rows: CsvRow[],
  column: string,
): { value: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const v = (row[column] ?? '').trim();
    if (!v) continue;
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
}
