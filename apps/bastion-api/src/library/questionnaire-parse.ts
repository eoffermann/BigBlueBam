// Questionnaire parsing, column mapping and write-back (spec 2.7 steps 1-2, 7). Pure and
// deterministic: bytes or pasted text become a grid of strings per sheet (via
// @bigbluebam/structured-data's xlsx and CSV codecs), Bastion guesses which column holds the
// questions (a person checks it), the mapping becomes one item per question, and an approved
// questionnaire is written back into its own layout with every cell formula-neutralized.

import {
  BASTION_QUESTIONNAIRE_MAX_CELL_CHARS,
  BASTION_QUESTIONNAIRE_MAX_COLUMNS,
  type BastionAnswerKind,
  type BastionQuestionnaireColumnMap,
  type BastionQuestionnaireSheetMap,
  neutralizeCsvField,
  neutralizeCsvValue,
} from '@bigbluebam/shared';
import { decodeCsvGrid, decodeXlsx, encodeXlsx, looksLikeXlsx, XlsxError, type SheetGrid } from '@bigbluebam/structured-data';
import { ValidationFailure } from '../lib/errors.js';

export interface ParsedQuestionnaire {
  format: 'xlsx' | 'csv';
  sheets: SheetGrid[];
  /** A sheet was cut at the row, column or sheet limit. */
  truncated: boolean;
}

/** What column_map holds: the person-checked mapping plus the grid it applies to (for write-back). */
export interface StoredColumnMap extends BastionQuestionnaireColumnMap {
  /** Bastion's guess (true) or a person's choice (false). */
  guessed: boolean;
  source: ParsedQuestionnaire;
}

function clampGrid(rows: string[][], maxRows: number): { rows: string[][]; truncated: boolean } {
  let truncated = rows.length > maxRows;
  const out = rows.slice(0, maxRows).map((r) => {
    if (r.length > BASTION_QUESTIONNAIRE_MAX_COLUMNS) truncated = true;
    return r.slice(0, BASTION_QUESTIONNAIRE_MAX_COLUMNS).map((c) => {
      const s = String(c ?? '');
      return s.length > BASTION_QUESTIONNAIRE_MAX_CELL_CHARS ? s.slice(0, BASTION_QUESTIONNAIRE_MAX_CELL_CHARS) : s;
    });
  });
  return { rows: out, truncated };
}

/**
 * Read a questionnaire file: an xlsx workbook when the bytes are a zip, else UTF-8 CSV (the
 * delimiter is detected, so TSV works too). Rows beyond `maxRows` plus a header margin are cut.
 */
export function parseQuestionnaireBytes(bytes: Uint8Array, maxRows: number): ParsedQuestionnaire {
  const rowCap = maxRows + 50;
  if (looksLikeXlsx(bytes)) {
    try {
      const r = decodeXlsx(bytes, { maxRows: rowCap, maxColumns: BASTION_QUESTIONNAIRE_MAX_COLUMNS, maxSheets: 20 });
      let truncated = r.truncated;
      const sheets = r.sheets.map((s) => {
        const c = clampGrid(s.rows, rowCap);
        if (c.truncated) truncated = true;
        return { name: s.name.slice(0, 128), rows: c.rows };
      });
      return { format: 'xlsx', sheets, truncated };
    } catch (err) {
      if (err instanceof XlsxError) throw new ValidationFailure(err.message, 'QUESTIONNAIRE_UNREADABLE');
      throw err;
    }
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ValidationFailure('This file is not an Excel workbook or a CSV file Bastion can read. Save it as .xlsx or .csv and try again.', 'QUESTIONNAIRE_UNREADABLE');
  }
  if (text.includes('\u0000')) {
    throw new ValidationFailure('This file is not an Excel workbook or a CSV file Bastion can read. Save it as .xlsx or .csv and try again.', 'QUESTIONNAIRE_UNREADABLE');
  }
  const c = clampGrid(decodeCsvGrid(text), rowCap);
  return { format: 'csv', sheets: [{ name: '', rows: c.rows }], truncated: c.truncated };
}

/** Pasted rows (from a spreadsheet: tab-separated; or CSV text). Stored as format `csv`. */
export function parsePastedQuestionnaire(text: string, format: 'csv' | 'tsv', maxRows: number): ParsedQuestionnaire {
  const c = clampGrid(decodeCsvGrid(text, format), maxRows + 50);
  return { format: 'csv', sheets: [{ name: '', rows: c.rows }], truncated: c.truncated };
}

/* ------------------------------ guessing the mapping ------------------------------ */

const QUESTION_HEADER = /\b(question|questions|requirement|query|control (?:question|description)|description|item|ask)\b/i;
const ANSWER_HEADER = /\b(answer|response|reply|vendor (?:answer|response)|comments?|explanation|details)\b/i;
const YES_NO_HEADER = /(yes\s*\/\s*no|\by\s*\/\s*n\b|\bcompliant\b|\bin place\b|\bstatus\b)/i;
const SECTION_HEADER = /\b(section|category|domain|area|topic|group)\b/i;

function findColumn(row: string[], re: RegExp, exclude: Set<number>): number | null {
  for (let i = 0; i < row.length; i++) {
    if (exclude.has(i)) continue;
    if (re.test((row[i] ?? '').trim())) return i;
  }
  return null;
}

/** The column holding the longest text on average, a fair guess for a sheet without a header. */
function longestTextColumn(rows: string[][]): number {
  const totals = new Map<number, number>();
  for (const r of rows.slice(0, 40)) r.forEach((c, i) => totals.set(i, (totals.get(i) ?? 0) + (c ?? '').trim().length));
  let best = 0;
  let bestLen = -1;
  for (const [i, n] of totals) if (n > bestLen) [best, bestLen] = [i, n];
  return best;
}

function guessSheet(sheet: SheetGrid): { map: BastionQuestionnaireSheetMap; header: boolean } | null {
  const rows = sheet.rows;
  if (!rows.some((r) => r.some((c) => (c ?? '').trim().length > 0))) return null;
  for (let h = 0; h < Math.min(rows.length, 10); h++) {
    const row = rows[h] ?? [];
    const q = findColumn(row, QUESTION_HEADER, new Set());
    if (q === null) continue;
    // A header cell is short, and a header row names at least two columns unless the cell is
    // just "Question(s)": "Please answer every question." on an instructions sheet is not one.
    const cell = (row[q] ?? '').trim();
    const filled = row.filter((c) => (c ?? '').trim().length > 0).length;
    if (cell.length > 40 || (filled < 2 && !/^\W*(questions?|requirements?)\W*$/i.test(cell))) continue;
    const used = new Set([q]);
    const yesNo = findColumn(row, YES_NO_HEADER, used);
    if (yesNo !== null) used.add(yesNo);
    const answer = findColumn(row, ANSWER_HEADER, used);
    if (answer !== null) used.add(answer);
    const section = findColumn(row, SECTION_HEADER, used);
    const kind: BastionAnswerKind = yesNo !== null && answer === null ? 'yes_no' : 'yes_no_text';
    return {
      header: true,
      map: { sheet_name: sheet.name, header_row: h, first_row: h + 1, question_column: q, answer_column: answer, yes_no_column: yesNo, section_column: section, answer_kind: kind },
    };
  }
  return {
    header: false,
    map: {
      sheet_name: sheet.name,
      header_row: null,
      first_row: 0,
      question_column: longestTextColumn(rows),
      answer_column: null,
      yes_no_column: null,
      section_column: null,
      answer_kind: 'yes_no_text',
    },
  };
}

/**
 * Bastion's guess at the mapping: every sheet with a recognizable question header, or (when no
 * sheet has one) the first non-empty sheet's longest-text column. A person checks it before
 * anything is drafted.
 */
export function guessColumnMap(parsed: ParsedQuestionnaire): BastionQuestionnaireColumnMap {
  const guesses = parsed.sheets.map(guessSheet).filter((g): g is NonNullable<typeof g> => g !== null);
  const withHeader = guesses.filter((g) => g.header).map((g) => g.map);
  if (withHeader.length > 0) return { sheets: withHeader.slice(0, 20) };
  const first = guesses[0];
  if (!first) throw new ValidationFailure('This questionnaire has no questions in it.', 'QUESTIONNAIRE_EMPTY');
  return { sheets: [first.map] };
}

/* ------------------------------ items from the mapping ------------------------------ */

export interface ItemDraftRow {
  sheet_name: string;
  row_index: number;
  section: string | null;
  question_text: string;
  answer_kind: BastionAnswerKind;
}

/** One item per non-empty question cell under each mapped sheet. Refuses more than `maxRows`. */
export function itemsFromMap(parsed: ParsedQuestionnaire, map: BastionQuestionnaireColumnMap, maxRows: number): ItemDraftRow[] {
  const out: ItemDraftRow[] = [];
  const seen = new Set<string>();
  for (const m of map.sheets) {
    const sheet = parsed.sheets.find((s) => s.name === m.sheet_name);
    if (!sheet) throw new ValidationFailure(`There is no sheet called "${m.sheet_name}" in this questionnaire.`, 'SHEET_NOT_FOUND');
    if (seen.has(m.sheet_name)) throw new ValidationFailure(`The sheet "${m.sheet_name}" is mapped twice.`, 'SHEET_MAPPED_TWICE');
    seen.add(m.sheet_name);
    let section: string | null = null;
    for (let r = m.first_row; r < sheet.rows.length; r++) {
      const row = sheet.rows[r] ?? [];
      const q = (row[m.question_column] ?? '').trim();
      const sec = m.section_column !== null ? (row[m.section_column] ?? '').trim() : '';
      if (sec) section = sec.slice(0, 256);
      if (q.length < 3) continue;
      out.push({ sheet_name: m.sheet_name, row_index: r, section, question_text: q.slice(0, BASTION_QUESTIONNAIRE_MAX_CELL_CHARS), answer_kind: m.answer_kind });
    }
  }
  if (out.length === 0) throw new ValidationFailure('No questions were found with this mapping. Pick the column that holds the questions.', 'QUESTIONNAIRE_EMPTY');
  if (out.length > maxRows) {
    throw new ValidationFailure(
      `This questionnaire has ${out.length} questions; Bastion takes up to ${maxRows} at a time. Split it into parts and add each one.`,
      'QUESTIONNAIRE_TOO_LARGE',
    );
  }
  return out;
}

/** What the mapping screen shows: the first rows of each sheet, never the whole grid. */
export function previewSheets(parsed: ParsedQuestionnaire, rows = 8) {
  return parsed.sheets.map((s) => ({
    name: s.name,
    row_count: s.rows.length,
    column_count: s.rows.reduce((n, r) => Math.max(n, r.length), 0),
    rows: s.rows.slice(0, rows).map((r) => r.map((c) => (c.length > 160 ? `${c.slice(0, 157)}...` : c))),
  }));
}

/* ------------------------------ write-back ------------------------------ */

export interface AnsweredItem {
  sheet_name: string;
  row_index: number;
  answer: string | null;
  yes_no: boolean | null;
}

const yesNoWord = (v: boolean | null) => (v === true ? 'Yes' : v === false ? 'No' : '');

/**
 * The questionnaire's own sheets with the answers written in: into the mapped answer and yes/no
 * columns, or into new "Answer" / "Yes/No" columns at the right. Every cell is neutralized
 * against formula injection (packages/shared/src/csv-safe.ts), the question text included,
 * because the file goes to someone else's spreadsheet.
 */
export function answeredGrid(parsed: ParsedQuestionnaire, map: BastionQuestionnaireColumnMap, items: AnsweredItem[]): Array<SheetGrid & { mapped: boolean }> {
  const byKey = new Map(items.map((i) => [`${i.sheet_name}\u0000${i.row_index}`, i]));
  return parsed.sheets.map((sheet) => {
    const m = map.sheets.find((x) => x.sheet_name === sheet.name);
    const rows = sheet.rows.map((r) => [...r]);
    if (m) {
      const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
      const wantsYesNo = m.answer_kind !== 'text';
      const wantsText = m.answer_kind !== 'yes_no';
      let answerCol = m.answer_column;
      let yesNoCol = m.yes_no_column;
      let next = width;
      if (wantsText && answerCol === null) answerCol = next++;
      if (wantsYesNo && yesNoCol === null) yesNoCol = next++;
      if (m.header_row !== null) {
        const header = rows[m.header_row] ?? [];
        if (answerCol !== null && m.answer_column === null) header[answerCol] = 'Answer';
        if (yesNoCol !== null && m.yes_no_column === null) header[yesNoCol] = 'Yes/No';
        rows[m.header_row] = header;
      }
      for (let r = 0; r < rows.length; r++) {
        const it = byKey.get(`${sheet.name}\u0000${r}`);
        if (!it) continue;
        const row = rows[r] ?? [];
        if (answerCol !== null) row[answerCol] = it.answer ?? '';
        if (yesNoCol !== null) row[yesNoCol] = yesNoWord(it.yes_no);
        rows[r] = row;
      }
    }
    const width = rows.reduce((n, r) => Math.max(n, r.length), 0);
    return {
      name: sheet.name || 'Questionnaire',
      mapped: !!m,
      rows: rows.map((r) => Array.from({ length: width }, (_, i) => neutralizeCsvValue(r[i] ?? ''))),
    };
  });
}

/** The answered questionnaire as CSV (formula-neutralized, CRLF): the mapped sheets only; several get a "Sheet" column. */
export function answeredCsv(sheets: Array<SheetGrid & { mapped: boolean }>): string {
  const keep = sheets.filter((s) => s.mapped);
  const list = keep.length > 0 ? keep : sheets.slice(0, 1);
  const lines: string[] = [];
  const multi = list.length > 1;
  for (const s of list) {
    for (const r of s.rows) lines.push((multi ? [s.name, ...r] : r).map(neutralizeCsvField).join(','));
  }
  return lines.join('\r\n');
}

/** The answered questionnaire as an xlsx workbook (inline strings only; never a formula). */
export function answeredXlsx(sheets: Array<SheetGrid & { mapped?: boolean }>): Uint8Array {
  return encodeXlsx(sheets.map((s) => ({ name: s.name, rows: s.rows })));
}
