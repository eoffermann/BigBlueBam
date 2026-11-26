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
 * - XML is scanned with a small tag scanner, never a DOM parser: no DTDs, no entity
 *   expansion beyond the five predefined entities and numeric references, so no XXE and no
 *   billion-laughs.
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
}

export interface XlsxReadResult {
  sheets: SheetGrid[];
  /** True when a limit cut rows, columns or sheets off. */
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

const DEFAULTS = { maxUncompressedBytes: 32 * 1024 * 1024, maxSheets: 20, maxRows: 10_000, maxColumns: 200 };

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

/** Characters XML 1.0 forbids (C0 controls other than tab, LF, CR), removed on write. */
const INVALID_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;

export function escapeXmlText(s: string): string {
  return s.replace(INVALID_XML_CHARS, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Attributes of one start tag (`<c r="A1" t="s">` -> { r: 'A1', t: 's' }). Namespace prefixes kept. */
function attrsOf(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null = re.exec(tag);
  while (m) {
    out[m[1] as string] = decodeXmlText((m[3] ?? m[4] ?? '') as string);
    m = re.exec(tag);
  }
  return out;
}

/** Local element name without a namespace prefix (`x:row` -> `row`). */
function local(name: string): string {
  const i = name.indexOf(':');
  return i >= 0 ? name.slice(i + 1) : name;
}

/** Concatenated text of every <t> inside a fragment, skipping phonetic runs (<rPh>). */
function textRuns(fragment: string): string {
  const noPhonetic = fragment.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
  let out = '';
  const re = /<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>|<(?:\w+:)?t(?:\s[^>]*)?\/>/g;
  let m: RegExpExecArray | null = re.exec(noPhonetic);
  while (m) {
    out += decodeXmlText(m[1] ?? '');
    m = re.exec(noPhonetic);
  }
  return out;
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

function readSharedStrings(xml: string | undefined): string[] {
  if (!xml) return [];
  const out: string[] = [];
  const re = /<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>|<(?:\w+:)?si\b[^>]*\/>/g;
  let m: RegExpExecArray | null = re.exec(xml);
  while (m) {
    out.push(textRuns(m[1] ?? ''));
    m = re.exec(xml);
  }
  return out;
}

function readSheet(xml: string, shared: string[], limits: Required<XlsxReadLimits>): { rows: string[][]; truncated: boolean } {
  const rows: string[][] = [];
  let truncated = false;
  const rowRe = /<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g;
  let nextRow = 0;
  let rm: RegExpExecArray | null = rowRe.exec(xml);
  while (rm) {
    const rowAttrs = attrsOf(rm[1] ?? '');
    const rIndex = rowAttrs.r ? Number.parseInt(rowAttrs.r, 10) - 1 : nextRow;
    const rowIndex = Number.isFinite(rIndex) && rIndex >= nextRow ? rIndex : nextRow;
    nextRow = rowIndex + 1;
    if (rowIndex >= limits.maxRows) {
      truncated = true;
      break;
    }
    const cells: string[] = [];
    const body = rm[2] ?? '';
    const cellRe = /<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g;
    let nextCol = 0;
    let cm: RegExpExecArray | null = cellRe.exec(body);
    while (cm) {
      const a = attrsOf(cm[1] ?? '');
      const ci = a.r ? columnIndexOf(a.r) : -1;
      const col = ci >= nextCol ? ci : nextCol;
      nextCol = col + 1;
      if (col >= limits.maxColumns) {
        truncated = true;
        cm = cellRe.exec(body);
        continue;
      }
      const inner = cm[2] ?? '';
      const v = /<(?:\w+:)?v(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner)?.[1];
      let value = '';
      switch (a.t) {
        case 's': {
          const idx = v === undefined ? Number.NaN : Number.parseInt(v, 10);
          value = Number.isInteger(idx) && idx >= 0 && idx < shared.length ? (shared[idx] as string) : '';
          break;
        }
        case 'inlineStr':
          value = textRuns(/<(?:\w+:)?is\b[^>]*>([\s\S]*?)<\/(?:\w+:)?is>/.exec(inner)?.[1] ?? '');
          break;
        case 'b':
          value = v === undefined ? '' : decodeXmlText(v).trim() === '1' ? 'TRUE' : 'FALSE';
          break;
        default:
          // n (number), str (formula string result), e (error), d (ISO date): the cached text.
          value = v === undefined ? '' : decodeXmlText(v);
      }
      while (cells.length < col) cells.push('');
      cells[col] = value;
      cm = cellRe.exec(body);
    }
    while (rows.length < rowIndex) rows.push([]);
    rows[rowIndex] = cells;
    rm = rowRe.exec(xml);
  }
  return { rows, truncated };
}

/**
 * Read every sheet of an xlsx workbook as a grid of strings. Throws XlsxError on input that is
 * not an xlsx (`NOT_XLSX`), exceeds the byte budget (`TOO_LARGE`), or is missing the workbook
 * parts (`MALFORMED`).
 */
export function decodeXlsx(bytes: Uint8Array, limitsIn: XlsxReadLimits = {}): XlsxReadResult {
  const limits: Required<XlsxReadLimits> = { ...DEFAULTS, ...limitsIn };
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
    throw new XlsxError('MALFORMED', 'This workbook could not be opened. Save it again from your spreadsheet app and retry.');
  }
  if (!declared.has('xl/workbook.xml')) throw new XlsxError('NOT_XLSX', 'This file is not an Excel workbook (.xlsx).');

  let budget = limits.maxUncompressedBytes;
  let inflated = 0;
  const read = (names: string[]): Record<string, string> => {
    const wanted = names.filter((n) => declared.has(n));
    for (const n of wanted) {
      budget -= declared.get(n) ?? 0;
      if (budget < 0) throw new XlsxError('TOO_LARGE', 'This workbook is too large to read here.');
    }
    const set = new Set(wanted);
    let files: Record<string, Uint8Array>;
    try {
      files = unzipSync(bytes, { filter: (f) => set.has(f.name) });
    } catch {
      throw new XlsxError('MALFORMED', 'This workbook could not be opened. Save it again from your spreadsheet app and retry.');
    }
    const out: Record<string, string> = {};
    for (const [n, data] of Object.entries(files)) {
      // The declared size can lie; what was actually inflated is charged against the budget too.
      inflated += data.length;
      if (inflated > limits.maxUncompressedBytes) throw new XlsxError('TOO_LARGE', 'This workbook is too large to read here.');
      out[n] = strFromU8(data);
    }
    return out;
  };

  const meta = read(['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml']);
  const workbook = meta['xl/workbook.xml'] ?? '';
  const rels = new Map<string, string>();
  const relRe = /<(?:\w+:)?Relationship\b([^>]*?)\/?>/g;
  let rm: RegExpExecArray | null = relRe.exec(meta['xl/_rels/workbook.xml.rels'] ?? '');
  while (rm) {
    const a = attrsOf(rm[1] ?? '');
    if (a.Id && a.Target) rels.set(a.Id, normalizePartPath(a.Target));
    rm = relRe.exec(meta['xl/_rels/workbook.xml.rels'] ?? '');
  }
  const sheetRefs: Array<{ name: string; path: string }> = [];
  const sheetRe = /<(?:\w+:)?sheet\b([^>]*?)\/?>/g;
  let sm: RegExpExecArray | null = sheetRe.exec(workbook);
  let truncated = false;
  while (sm) {
    const a = attrsOf(sm[1] ?? '');
    const relId = Object.entries(a).find(([k]) => local(k) === 'id' && k !== 'sheetId')?.[1];
    const path = relId ? rels.get(relId) : undefined;
    if (a.name !== undefined && path) {
      if (sheetRefs.length >= limits.maxSheets) {
        truncated = true;
        break;
      }
      sheetRefs.push({ name: a.name, path });
    }
    sm = sheetRe.exec(workbook);
  }
  if (sheetRefs.length === 0) throw new XlsxError('MALFORMED', 'This workbook has no sheets.');

  const shared = readSharedStrings(meta['xl/sharedStrings.xml']);
  const sheetXml = read(sheetRefs.map((s) => s.path));
  const sheets: SheetGrid[] = [];
  for (const ref of sheetRefs) {
    const xml = sheetXml[ref.path];
    if (xml === undefined) continue;
    const r = readSheet(xml, shared, limits);
    if (r.truncated) truncated = true;
    sheets.push({ name: ref.name, rows: r.rows });
  }
  return { sheets, truncated };
}

/* ------------------------------------------------------------------ */
/*  Writer                                                             */
/* ------------------------------------------------------------------ */

/** A sheet tab name Excel accepts: 1-31 chars, none of []:*?/\, unique in the workbook. */
export function safeSheetName(name: string, taken: Set<string>): string {
  let base = name.replace(/[[\]:*?/\\]/g, ' ').replace(INVALID_XML_CHARS, '').trim().slice(0, 31) || 'Sheet';
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
