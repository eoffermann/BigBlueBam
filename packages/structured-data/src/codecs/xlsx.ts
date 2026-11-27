import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';

/**
 * A minimal, dependency-light xlsx (Office Open XML spreadsheet) reader and writer.
 *
 * Scope: cell VALUES only, as strings, per sheet (a grid). Styles, merged cells, formulas
 * (the cached result is read, the formula itself never), comments, images and macros are
 * ignored on read and never written. That is exactly what a questionnaire, an import or an
 * export needs, and it keeps the attack surface small:
 *
 * - The zip is read with fflate (no native code). Every entry's declared size is checked
 *   against a total budget BEFORE it is inflated, and only the parts this reader needs are
 *   inflated at all (a zip bomb in an unrelated part costs nothing).
 * - XML is read by a single-pass tag scanner (XmlCursor below), never a DOM parser and never a
 *   regular expression over the document: the cursor only moves forward, so every byte is looked
 *   at once and reading is linear in the input (#270). An element that is never closed, a tag
 *   nested where it cannot be (a row inside a row), a stray "<" inside a tag or a DTD is refused
 *   at once as MALFORMED. No entity expansion beyond the five predefined entities and numeric
 *   references, so no XXE and no billion-laughs.
 * - What the reader PRODUCES is budgeted, not only what it inflates (#265, #273): a shared-string
 *   cell costs ~20 bytes of XML but expands to the whole string every time it is used, so every
 *   emitted cell is charged against maxCells (cell slots, padding included) and maxTotalChars
 *   (decoded characters, shared-string expansions included), and each cell is cut at
 *   maxCellChars. Going over maxCells or maxTotalChars throws TOO_LARGE before the grid grows.
 * - The writer emits every cell as an inline string (`t="inlineStr"`), which a spreadsheet
 *   shows as text and never evaluates as a formula. Callers that also export CSV should still
 *   neutralize formula prefixes (packages/shared/src/csv-safe.ts) so both downloads agree.
 */

export interface SheetGrid {
  /** The sheet's tab name. */
  name: string;
  /** Rows of cells, top to bottom; every cell a string ('' when empty). Ragged rows are allowed. */
  rows: string[][];
}

export interface XlsxReadLimits {
  /** Total declared uncompressed bytes of the parts read (default 32 MiB). */
  maxUncompressedBytes?: number;
  /** Sheets read, in workbook order (default 20); later sheets are ignored. */
  maxSheets?: number;
  /** Rows kept per sheet (default 10,000); later rows are ignored and `truncated` is set. */
  maxRows?: number;
  /** Columns kept per row (default 200). */
  maxColumns?: number;
  /** Cell slots produced across every sheet, empty padding included (default 1,000,000); more throws TOO_LARGE. */
  maxCells?: number;
  /** Characters kept per cell (default 32,767, Excel's own limit); longer cells are cut and `truncated` is set. */
  maxCellChars?: number;
  /** Decoded characters produced across every cell, shared-string expansions included (default 32 M); more throws TOO_LARGE. */
  maxTotalChars?: number;
  /** Entries in the shared-string table (default 1,000,000); more throws TOO_LARGE. */
  maxSharedStrings?: number;
}

export interface XlsxReadResult {
  sheets: SheetGrid[];
  /** True when a limit cut rows, columns, cells' text or sheets off. */
  truncated: boolean;
}

export type XlsxErrorCode = 'NOT_XLSX' | 'TOO_LARGE' | 'MALFORMED';

export class XlsxError extends Error {
  constructor(
    public readonly code: XlsxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'XlsxError';
  }
}

const DEFAULTS: Required<XlsxReadLimits> = {
  maxUncompressedBytes: 32 * 1024 * 1024,
  maxSheets: 20,
  maxRows: 10_000,
  maxColumns: 200,
  maxCells: 1_000_000,
  maxCellChars: 32_767,
  maxTotalChars: 32 * 1024 * 1024,
  maxSharedStrings: 1_000_000,
};

const MALFORMED_WORDS = 'This workbook could not be opened. Save it again from your spreadsheet app and retry.';
const TOO_LARGE_WORDS = 'This workbook is too large to read here.';
const TOO_MUCH_TEXT_WORDS = 'This workbook holds more cells or text than can be read here. Save just the questions and try again.';

/** True when the bytes start like a zip archive (every xlsx is one). */
export function looksLikeXlsx(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/* ------------------------------------------------------------------ */
/*  XML helpers                                                        */
/* ------------------------------------------------------------------ */

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Decode the five predefined XML entities and numeric character references. Nothing else. */
export function decodeXmlText(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref.startsWith('#x') || ref.startsWith('#X')) {
      const cp = Number.parseInt(ref.slice(2), 16);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    if (ref.startsWith('#')) {
      const cp = Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return NAMED_ENTITIES[ref] ?? whole;
  });
}

/** Drop characters XML 1.0 forbids (C0 controls other than tab, LF and CR; U+FFFE and U+FFFF). */
export function stripInvalidXmlChars(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const forbidden = (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0xfffe || c === 0xffff;
    if (!forbidden) out += s[i];
  }
  return out;
}

export function escapeXmlText(s: string): string {
  return stripInvalidXmlChars(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const isSpace = (c: number) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;

/**
 * Attributes of one start tag's attribute text (`r="A1" t="s"` -> { r: 'A1', t: 's' }), read in one
 * forward pass (no regex backtracking). Namespace prefixes kept. Quotes are balanced: the cursor
 * only hands over tags whose quotes closed.
 */
export function attrsOf(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const n = s.length;
  let i = 0;
  while (i < n) {
    while (i < n && isSpace(s.charCodeAt(i))) i++;
    const start = i;
    while (i < n) {
      const c = s.charCodeAt(i);
      if (isSpace(c) || c === 0x3d /* = */ || c === 0x2f /* / */) break;
      i++;
    }
    const name = s.slice(start, i);
    if (!name) {
      i++;
      continue;
    }
    while (i < n && isSpace(s.charCodeAt(i))) i++;
    if (s.charCodeAt(i) !== 0x3d) continue;
    i++;
    while (i < n && isSpace(s.charCodeAt(i))) i++;
    const q = s[i];
    if (q !== '"' && q !== "'") continue;
    const end = s.indexOf(q, i + 1);
    if (end < 0) break;
    out[name] = decodeXmlText(s.slice(i + 1, end));
    i = end + 1;
  }
  return out;
}

/** Local element name without a namespace prefix (`x:row` -> `row`). */
function local(name: string): string {
  const i = name.indexOf(':');
  return i >= 0 ? name.slice(i + 1) : name;
}

type XmlToken =
  | { kind: 'open'; name: string; local: string; attrs: string; selfClosing: boolean }
  | { kind: 'close'; name: string; local: string }
  | { kind: 'text'; text: string; raw: boolean };

const MAX_DEPTH = 128;

/**
 * A forward-only XML tag scanner (#270). Each call to next() starts where the last one ended and
 * finds the next "<" with indexOf, so no byte is scanned twice and reading is linear. It keeps a
 * stack of open elements: a close tag must match the innermost open one, and the document must
 * end with nothing open; anything else is MALFORMED at the first place it goes wrong. Comments
 * and processing instructions are skipped; CDATA is text; a DTD (`<!DOCTYPE`) is refused.
 */
export class XmlCursor {
  private pos = 0;
  private readonly stack: string[] = [];
  constructor(private readonly s: string) {}

  /** How many elements are open right now. */
  get depth(): number {
    return this.stack.length;
  }

  next(): XmlToken | null {
    const s = this.s;
    const n = s.length;
    for (;;) {
      if (this.pos >= n) {
        if (this.stack.length > 0) throw new XlsxError('MALFORMED', MALFORMED_WORDS);
        return null;
      }
      const lt = s.indexOf('<', this.pos);
      if (lt < 0) {
        const text = s.slice(this.pos);
        this.pos = n;
        return { kind: 'text', text, raw: false };
      }
      if (lt > this.pos) {
        const text = s.slice(this.pos, lt);
        this.pos = lt;
        return { kind: 'text', text, raw: false };
      }
      if (s.startsWith('<!--', lt)) {
        const end = s.indexOf('-->', lt + 4);
        if (end < 0) throw new XlsxError('MALFORMED', MALFORMED_WORDS);
        this.pos = end + 3;
        continue;
      }
      if (s.startsWith('<![CDATA[', lt)) {
        const end = s.indexOf(']]>', lt + 9);
        if (end < 0) throw new XlsxError('MALFORMED', MALFORMED_WORDS);
        this.pos = end + 3;
        return { kind: 'text', text: s.slice(lt + 9, end), raw: true };
      }
      if (s.startsWith('<?', lt)) {
        const end = s.indexOf('?>', lt + 2);
        if (end < 0) throw new XlsxError('MALFORMED', MALFORMED_WORDS);
        this.pos = end + 2;
        continue;
      }
      // `<!DOCTYPE` and any other declaration: a spreadsheet never writes one, and refusing it is
      // what keeps entity definitions out entirely.
      if (s.startsWith('<!', lt)) throw new XlsxError('MALFORMED', MALFORMED_WORDS);

      // A tag: find its end, honouring quoted attribute values; a "<" inside a tag is malformed.
      let i = lt + 1;
      const closing = s.charCodeAt(i) === 0x2f;
      if (closing) i++;
      let quote = 0;
      let j = i;
      for (; j < n; j++) {
        const c = s.charCodeAt(j);
        if (quote !== 0) {
          if (c === quote) quote = 0;
        } else if (c === 0x22 || c === 0x27) quote = c;
        else if (c === 0x3e /* > */) break;
        else if (c === 0x3c /* < */) throw new XlsxError('MALFORMED', MALFORMED_WORDS);
      }
      if (j >= n) throw new XlsxError('MALFORMED', MALFORMED_WORDS);
      this.pos = j + 1;
      let body = s.slice(i, j);
      const selfClosing = !closing && body.endsWith('/');
      if (selfClosing) body = body.slice(0, -1);
      let k = 0;
      while (k < body.length && !isSpace(body.charCodeAt(k))) k++;
      const name = body.slice(0, k);
      if (!name) throw new XlsxError('MALFORMED', MALFORMED_WORDS);
      if (closing) {
        if (this.stack.pop() !== name) throw new XlsxError('MALFORMED', MALFORMED_WORDS);
        return { kind: 'close', name, local: local(name) };
      }
      if (!selfClosing) {
        if (this.stack.length >= MAX_DEPTH) throw new XlsxError('MALFORMED', MALFORMED_WORDS);
        this.stack.push(name);
      }
      return { kind: 'open', name, local: local(name), attrs: body.slice(k), selfClosing };
    }
  }
}

/** Decoded text of a text token (CDATA is literal; character data has its entities decoded). */
const tokenText = (t: { text: string; raw: boolean }) => (t.raw ? t.text : decodeXmlText(t.text));

/** What every sheet of one workbook has produced so far, charged against the limits (#265, #273). */
interface OutputBudget {
  cells: number;
  chars: number;
  truncated: boolean;
}

function chargeCells(budget: OutputBudget, limits: Required<XlsxReadLimits>, n: number): void {
  budget.cells += n;
  if (budget.cells > limits.maxCells) throw new XlsxError('TOO_LARGE', TOO_MUCH_TEXT_WORDS);
}

/** A cell's value cut to maxCellChars and charged against maxTotalChars. */
function chargeText(budget: OutputBudget, limits: Required<XlsxReadLimits>, value: string): string {
  let v = value;
  if (v.length > limits.maxCellChars) {
    v = v.slice(0, limits.maxCellChars);
    budget.truncated = true;
  }
  budget.chars += v.length;
  if (budget.chars > limits.maxTotalChars) throw new XlsxError('TOO_LARGE', TOO_MUCH_TEXT_WORDS);
  return v;
}

/** Zero-based column index of a cell reference's letters (`C7` -> 2). -1 when there are none. */
export function columnIndexOf(ref: string): number {
  const letters = /^([A-Za-z]+)/.exec(ref)?.[1];
  if (!letters) return -1;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** Column letters for a zero-based index (2 -> `C`, 26 -> `AA`). */
export function columnLetters(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/* ------------------------------------------------------------------ */
/*  Reader                                                             */
/* ------------------------------------------------------------------ */

function normalizePartPath(target: string): string {
  // Relationship targets are relative to xl/ unless absolute (`/xl/worksheets/sheet1.xml`).
  if (target.startsWith('/')) return target.slice(1);
  const parts = `xl/${target}`.split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p !== '.' && p !== '') out.push(p);
  }
  return out.join('/');
}

/**
 * The shared-string table: the concatenated <t> runs of each <si>, phonetic runs (<rPh>) skipped.
 * One forward pass; an <si> or <t> opened inside another is MALFORMED. Each string is cut at
 * maxCellChars (it can never be shown longer than that).
 */
function readSharedStrings(xml: string | undefined, limits: Required<XlsxReadLimits>, output: OutputBudget): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const cur = new XmlCursor(xml);
  let inSi = false;
  let inT = false;
  let phonetic = 0;
  let parts: string[] = [];
  let len = 0;
  for (let t = cur.next(); t; t = cur.next()) {
    if (t.kind === 'open') {
      if (t.local === 'si') {
        if (inSi) throw new XlsxError('MALFORMED', MALFORMED_WORDS);
        if (t.selfClosing) {
          out.push('');
        } else {
          inSi = true;
          parts = [];
          len = 0;
        }
        if (out.length > limits.maxSharedStrings) throw new XlsxError('TOO_LARGE', TOO_MUCH_TEXT_WORDS);
      } else if (inSi && t.local === 'rPh' && !t.selfClosing) phonetic += 1;
      else if (inSi && t.local === 't' && !t.selfClosing && phonetic === 0) {
        if (inT) throw new XlsxError('MALFORMED', MALFORMED_WORDS);
        inT = true;
      }
    } else if (t.kind === 'close') {
      if (t.local === 'si' && inSi) {
        inSi = false;
        inT = false;
        phonetic = 0;
        out.push(parts.join(''));
        if (out.length > limits.maxSharedStrings) throw new XlsxError('TOO_LARGE', TOO_MUCH_TEXT_WORDS);
      } else if (t.local === 'rPh' && phonetic > 0) phonetic -= 1;
      else if (t.local === 't') inT = false;
    } else if (inT && len < limits.maxCellChars) {
      const text = tokenText(t);
      parts.push(text);
      len += text.length;
      if (len > limits.maxCellChars) {
        output.truncated = true;
        const joined = parts.join('').slice(0, limits.maxCellChars);
        parts = [joined];
        len = joined.length;
      }
    }
  }
  return out;
}

/**
 * One sheet's rows, in one forward pass. Stops at the row limit without reading further. Every
 * cell slot (padding included) and every decoded character is charged to the workbook's budget.
 */
function readSheet(xml: string, shared: string[], limits: Required<XlsxReadLimits>, budget: OutputBudget): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let truncated = false;
  const cur = new XmlCursor(xml);
  let nextRow = 0;
  let row: string[] | null = null;
  let rowIndex = 0;
  let nextCol = 0;
  // The cell being read.
  let cell: { col: number; type: string | undefined } | null = null;
  let vParts: string[] | null = null;
  let inV = false;
  let inIs = false;
  let inT = false;
  let phonetic = 0;
  let isParts: string[] = [];
  let vLen = 0;
  let isLen = 0;

  const finishCell = () => {
    if (!cell || !row) return;
    const { col, type } = cell;
    cell = null;
    if (col >= limits.maxColumns) {
      truncated = true;
      return;
    }
    const v = vParts === null ? undefined : vParts.join('');
    let value = '';
    switch (type) {
      case 's': {
        const idx = v === undefined ? Number.NaN : Number.parseInt(v, 10);
        value = Number.isInteger(idx) && idx >= 0 && idx < shared.length ? (shared[idx] as string) : '';
        break;
      }
      case 'inlineStr':
        value = isParts.join('');
        break;
      case 'b':
        value = v === undefined ? '' : v.trim() === '1' ? 'TRUE' : 'FALSE';
        break;
      default:
        // n (number), str (formula string result), e (error), d (ISO date): the cached text.
        value = v ?? '';
    }
    const pad = col - row.length;
    chargeCells(budget, limits, (pad > 0 ? pad : 0) + 1);
    while (row.length < col) row.push('');
    row[col] = chargeText(budget, limits, value);
  };

  const finishRow = () => {
    if (!row) return;
    chargeCells(budget, limits, rowIndex - rows.length > 0 ? rowIndex - rows.length : 0);
    while (rows.length < rowIndex) rows.push([]);
    rows[rowIndex] = row;
    row = null;
  };

  for (let t = cur.next(); t; t = cur.next()) {
    if (t.kind === 'open') {
      switch (t.local) {
        case 'row': {
          if (row || cell) throw new XlsxError('MALFORMED', MALFORMED_WORDS);
          const a = attrsOf(t.attrs);
          const rIndex = a.r ? Number.parseInt(a.r, 10) - 1 : nextRow;
          rowIndex = Number.isFinite(rIndex) && rIndex >= nextRow ? rIndex : nextRow;
          nextRow = rowIndex + 1;
          if (rowIndex >= limits.maxRows) return { rows, truncated: true };
          row = [];
          nextCol = 0;
          if (t.selfClosing) finishRow();
          break;
        }
        case 'c': {
          if (!row || cell) throw new XlsxError('MALFORMED', MALFORMED_WORDS);
          const a = attrsOf(t.attrs);
          const ci = a.r ? columnIndexOf(a.r) : -1;
          const col = ci >= nextCol ? ci : nextCol;
          nextCol = col + 1;
          cell = { col, type: a.t };
          vParts = null;
          isParts = [];
          vLen = 0;
          isLen = 0;
          if (t.selfClosing) finishCell();
          break;
        }
        case 'v':
          if (!cell || inV) throw new XlsxError('MALFORMED', MALFORMED_WORDS);
          vParts = [];
          vLen = 0;
          if (!t.selfClosing) inV = true;
          break;
        case 'is':
          if (!cell || inIs) throw new XlsxError('MALFORMED', MALFORMED_WORDS);
          if (!t.selfClosing) inIs = true;
          break;
        case 'rPh':
          if (inIs && !t.selfClosing) phonetic += 1;
          break;
        case 't':
          if (inIs && phonetic === 0 && !t.selfClosing) {
            if (inT) throw new XlsxError('MALFORMED', MALFORMED_WORDS);
            inT = true;
          }
          break;
        default:
          break;
      }
    } else if (t.kind === 'close') {
      switch (t.local) {
        case 'row':
          if (row) finishRow();
          break;
        case 'c':
          finishCell();
          inV = false;
          inIs = false;
          inT = false;
          phonetic = 0;
          break;
        case 'v':
          inV = false;
          break;
        case 'is':
          inIs = false;
          inT = false;
          break;
        case 'rPh':
          if (phonetic > 0) phonetic -= 1;
          break;
        case 't':
          inT = false;
          break;
        default:
          break;
      }
    } else if (inV && vParts) {
      // A value is a number, an index or a short cached result; cap what is kept so a huge <v>
      // costs no more than a cell can show.
      if (vLen < limits.maxCellChars) {
        const text = tokenText(t);
        vParts.push(text);
        vLen += text.length;
      }
    } else if (inT && inIs) {
      if (isLen < limits.maxCellChars) {
        const text = tokenText(t);
        isParts.push(text);
        isLen += text.length;
      }
    }
  }
  return { rows, truncated };
}

/**
 * Read every sheet of an xlsx workbook as a grid of strings. Throws XlsxError on input that is
 * not an xlsx (`NOT_XLSX`), exceeds the byte budget (`TOO_LARGE`), or is missing the workbook
 * parts (`MALFORMED`).
 */
export function decodeXlsx(bytes: Uint8Array, limitsIn: XlsxReadLimits = {}): XlsxReadResult {
  // An undefined field keeps its default (a spread would let `undefined` switch a limit off).
  const limits: Required<XlsxReadLimits> = { ...DEFAULTS };
  for (const [k, v] of Object.entries(limitsIn) as Array<[keyof XlsxReadLimits, number | undefined]>) {
    if (typeof v === 'number' && Number.isFinite(v)) limits[k] = v;
  }
  if (!looksLikeXlsx(bytes)) throw new XlsxError('NOT_XLSX', 'This file is not an Excel workbook (.xlsx).');

  // Pass 1: list entries (declared sizes) without inflating anything.
  const declared = new Map<string, number>();
  try {
    unzipSync(bytes, {
      filter: (f) => {
        declared.set(f.name, f.originalSize);
        return false;
      },
    });
  } catch {
    throw new XlsxError('MALFORMED', MALFORMED_WORDS);
  }
  if (!declared.has('xl/workbook.xml')) throw new XlsxError('NOT_XLSX', 'This file is not an Excel workbook (.xlsx).');

  let budget = limits.maxUncompressedBytes;
  let inflated = 0;
  const read = (names: string[]): Record<string, string> => {
    const wanted = names.filter((n) => declared.has(n));
    for (const n of wanted) {
      budget -= declared.get(n) ?? 0;
      if (budget < 0) throw new XlsxError('TOO_LARGE', TOO_LARGE_WORDS);
    }
    const set = new Set(wanted);
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes, { filter: (f) => set.has(f.name) });
    } catch {
      throw new XlsxError('MALFORMED', MALFORMED_WORDS);
    }
    const out: Record<string, string> = {};
    for (const [n, data] of Object.entries(files)) {
      // The declared size can lie; what was actually inflated is charged against the budget too.
      inflated += data.length;
      if (inflated > limits.maxUncompressedBytes) throw new XlsxError('TOO_LARGE', TOO_LARGE_WORDS);
      out[n] = strFromU8(data);
    }
    return out;
  };

  const meta = read(['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml']);
  const rels = new Map<string, string>();
  const relCur = new XmlCursor(meta['xl/_rels/workbook.xml.rels'] ?? '');
  for (let t = relCur.next(); t; t = relCur.next()) {
    if (t.kind !== 'open' || t.local !== 'Relationship') continue;
    const a = attrsOf(t.attrs);
    if (a.Id && a.Target) rels.set(a.Id, normalizePartPath(a.Target));
  }
  const sheetRefs: Array<{ name: string; path: string }> = [];
  const wbCur = new XmlCursor(meta['xl/workbook.xml'] ?? '');
  let truncated = false;
  for (let t = wbCur.next(); t; t = wbCur.next()) {
    if (t.kind !== 'open' || t.local !== 'sheet') continue;
    const a = attrsOf(t.attrs);
    const relId = Object.entries(a).find(([k]) => local(k) === 'id' && k !== 'sheetId')?.[1];
    const path = relId ? rels.get(relId) : undefined;
    if (a.name !== undefined && path) {
      if (sheetRefs.length >= limits.maxSheets) {
        truncated = true;
        break;
      }
      sheetRefs.push({ name: a.name, path });
    }
  }
  if (sheetRefs.length === 0) throw new XlsxError('MALFORMED', 'This workbook has no sheets.');

  const output: OutputBudget = { cells: 0, chars: 0, truncated: false };
  const shared = readSharedStrings(meta['xl/sharedStrings.xml'], limits, output);
  const sheetXml = read(sheetRefs.map((s) => s.path));
  const sheets: SheetGrid[] = [];
  for (const ref of sheetRefs) {
    const xml = sheetXml[ref.path];
    if (xml === undefined) continue;
    const r = readSheet(xml, shared, limits, output);
    if (r.truncated) truncated = true;
    sheets.push({ name: ref.name, rows: r.rows });
  }
  return { sheets, truncated: truncated || output.truncated };
}

/* ------------------------------------------------------------------ */
/*  Writer                                                             */
/* ------------------------------------------------------------------ */

/** A sheet tab name Excel accepts: 1-31 chars, none of []:*?/\, unique in the workbook. */
export function safeSheetName(name: string, taken: Set<string>): string {
  let base = stripInvalidXmlChars(name.replace(/[[\]:*?/\\]/g, ' ')).trim().slice(0, 31) || 'Sheet';
  if (base.startsWith("'")) base = base.slice(1) || 'Sheet';
  let candidate = base;
  let n = 2;
  while (taken.has(candidate.toLowerCase())) {
    const suffix = ` (${n})`;
    candidate = `${base.slice(0, 31 - suffix.length)}${suffix}`;
    n += 1;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

function sheetXml(rows: string[][]): string {
  const out: string[] = [];
  out.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  out.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>');
  rows.forEach((row, ri) => {
    const r = ri + 1;
    const cells: string[] = [];
    row.forEach((value, ci) => {
      if (value === '' || value === null || value === undefined) return;
      const text = escapeXmlText(String(value));
      const space = /^\s|\s$|\n/.test(text) ? ' xml:space="preserve"' : '';
      cells.push(`<c r="${columnLetters(ci)}${r}" t="inlineStr"><is><t${space}>${text}</t></is></c>`);
    });
    out.push(`<row r="${r}">${cells.join('')}</row>`);
  });
  out.push('</sheetData></worksheet>');
  return out.join('');
}

/**
 * Write grids as an xlsx workbook. Every non-empty cell is an inline string, so nothing in the
 * file is ever evaluated as a formula. Returns the zip bytes.
 */
export function encodeXlsx(sheets: SheetGrid[]): Uint8Array {
  const list = sheets.length > 0 ? sheets : [{ name: 'Sheet1', rows: [] }];
  const taken = new Set<string>();
  const names = list.map((s) => safeSheetName(s.name, taken));
  const files: Record<string, Uint8Array> = {};
  files['[Content_Types].xml'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      list
        .map(
          (_, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join('') +
      '</Types>',
  );
  files['_rels/.rels'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>',
  );
  files['xl/workbook.xml'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      names.map((n, i) => `<sheet name="${escapeXmlText(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      '</sheets></workbook>',
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      list
        .map(
          (_, i) =>
            `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join('') +
      `<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      '</Relationships>',
  );
  files['xl/styles.xml'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
      '</styleSheet>',
  );
  list.forEach((s, i) => {
    files[`xl/worksheets/sheet${i + 1}.xml`] = strToU8(sheetXml(s.rows));
  });
  return zipSync(files, { level: 6, mtime: new Date('2000-01-01T00:00:00Z') });
}
