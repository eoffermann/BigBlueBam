import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { decodeCsvGrid } from './csv.js';
import {
  columnIndexOf,
  columnLetters,
  decodeXlsx,
  decodeXmlText,
  encodeXlsx,
  escapeXmlText,
  looksLikeXlsx,
  safeSheetName,
  XlsxError,
} from './xlsx.js';

/** A workbook shaped the way Excel writes one: shared strings, a rich-text run, a phonetic run, numbers, a formula. */
function excelStyleWorkbook(): Uint8Array {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<Types/>'),
    'xl/workbook.xml': strToU8(
      '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<sheets><sheet name="Security &amp; Privacy" sheetId="1" r:id="rId7"/><sheet name="Notes" sheetId="2" r:id="rId8"/></sheets></workbook>',
    ),
    'xl/_rels/workbook.xml.rels': strToU8(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId7" Type="x" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId8" Type="x" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    ),
    'xl/sharedStrings.xml': strToU8(
      '<sst><si><t>Question</t></si><si><t>Answer</t></si>' +
        '<si><r><t>Do you encrypt </t></r><r><rPr><b/></rPr><t xml:space="preserve">laptops?</t></r></si>' +
        '<si><t>Tom &lt;&amp;&gt; Jerry &#x263A;</t><rPh><t>IGNORED</t></rPh></si></sst>',
    ),
    'xl/worksheets/sheet1.xml': strToU8(
      '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        '<row r="3"><c r="A3" t="s"><v>2</v></c><c r="C3"><v>42</v></c><c r="D3" t="b"><v>1</v></c></row>' +
        '<row r="4"><c r="B4" t="s"><v>3</v></c><c r="C4" t="str"><f>A1&amp;"x"</f><v>Questionx</v></c><c r="E4" t="inlineStr"><is><t>inline</t></is></c></row>' +
        '</sheetData></worksheet>',
    ),
    'xl/worksheets/sheet2.xml': strToU8('<worksheet><sheetData><row><c><v>1</v></c><c><v>2</v></c></row></sheetData></worksheet>'),
  };
  return zipSync(files);
}

describe('xlsx reader', () => {
  it('reads sheets in workbook order with shared, rich, inline, numeric, boolean and formula-result cells', () => {
    const { sheets, truncated } = decodeXlsx(excelStyleWorkbook());
    expect(truncated).toBe(false);
    expect(sheets.map((s) => s.name)).toEqual(['Security & Privacy', 'Notes']);
    const rows = sheets[0]?.rows ?? [];
    expect(rows[0]).toEqual(['Question', 'Answer']);
    expect(rows[1]).toEqual([]); // the missing row 2 keeps its position
    expect(rows[2]).toEqual(['Do you encrypt laptops?', '', '42', 'TRUE']);
    // Phonetic runs are skipped; entities decoded; the formula's cached value read, never the formula.
    expect(rows[3]).toEqual(['', 'Tom <&> Jerry ☺', 'Questionx', '', 'inline']);
    expect(sheets[1]?.rows).toEqual([['1', '2']]);
  });

  it('refuses something that is not a workbook', () => {
    expect(() => decodeXlsx(strToU8('Question,Answer\n'))).toThrow(XlsxError);
    const notWorkbook = zipSync({ 'word/document.xml': strToU8('<doc/>') });
    expect(() => decodeXlsx(notWorkbook)).toThrowError(/not an Excel workbook/);
    expect(looksLikeXlsx(notWorkbook)).toBe(true);
    expect(looksLikeXlsx(strToU8('PK'))).toBe(false);
  });

  it('refuses a part whose declared size exceeds the budget before inflating it', () => {
    const big = 'x'.repeat(200_000);
    const wb = zipSync({
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/worksheets/sheet1.xml': strToU8(`<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${big}</t></is></c></row></sheetData></worksheet>`),
    });
    try {
      decodeXlsx(wb, { maxUncompressedBytes: 50_000 });
      throw new Error('expected TOO_LARGE');
    } catch (e) {
      expect((e as XlsxError).code).toBe('TOO_LARGE');
    }
  });

  it('caps rows and columns and says so', () => {
    const rows = Array.from({ length: 30 }, (_, i) => [`q${i}`, 'a', 'b', 'c']);
    const { sheets, truncated } = decodeXlsx(encodeXlsx([{ name: 'S', rows }]), { maxRows: 10, maxColumns: 2 });
    expect(truncated).toBe(true);
    expect(sheets[0]?.rows).toHaveLength(10);
    expect(sheets[0]?.rows[0]).toEqual(['q0', 'a']);
  });

  it('ignores DTDs and custom entities (no expansion)', () => {
    expect(decodeXmlText('&lol; &amp; &#65;')).toBe('&lol; & A');
  });

  it('reads CDATA as literal text and skips comments', () => {
    const wb = workbookWith('<worksheet><sheetData><!-- a comment --><row r="1"><c r="A1" t="inlineStr"><is><t><![CDATA[a <b> & c]]></t></is></c></row></sheetData></worksheet>');
    expect(decodeXlsx(wb).sheets[0]?.rows).toEqual([['a <b> & c']]);
  });
});

/** A minimal workbook around one sheet part (and an optional shared-string part). */
function workbookWith(sheetXml: string, sharedStringsXml?: string): Uint8Array {
  return zipSync({
    'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="A" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml),
    ...(sharedStringsXml === undefined ? {} : { 'xl/sharedStrings.xml': strToU8(sharedStringsXml) }),
  });
}

function codeOf(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e instanceof XlsxError ? e.code : `not an XlsxError: ${(e as Error).message}`;
  }
}

/** Runs fn and returns [result code, elapsed ms]. */
function timed(fn: () => unknown): [string | null, number] {
  const t = performance.now();
  const code = codeOf(fn);
  return [code, performance.now() - t];
}

// #270: the old regex reader re-scanned to the end of the part for every unclosed tag (quadratic).
// Each of these parts deflates to a few KB; the reader must refuse it at the first unclosed tag,
// in linear time.
describe('xlsx reader: crafted parts are refused in linear time (#270)', () => {
  const N = 200_000;
  const BUDGET_MS = 500;

  it('refuses a sheet of unclosed <row> tags', () => {
    const wb = workbookWith(`<worksheet><sheetData>${'<row>'.repeat(N)}`);
    expect(wb.length).toBeLessThan(100_000);
    const [code, ms] = timed(() => decodeXlsx(wb));
    expect(code).toBe('MALFORMED');
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('refuses a sheet of unclosed <c> tags', () => {
    const [code, ms] = timed(() => decodeXlsx(workbookWith(`<worksheet><sheetData><row>${'<c>'.repeat(N)}`)));
    expect(code).toBe('MALFORMED');
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('refuses unclosed <t> tags inside an inline string', () => {
    const [code, ms] = timed(() => decodeXlsx(workbookWith(`<worksheet><sheetData><row><c t="inlineStr"><is>${'<t>'.repeat(N)}`)));
    expect(code).toBe('MALFORMED');
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('refuses a shared-string table of unclosed <si> tags before reading any sheet', () => {
    const [code, ms] = timed(() => decodeXlsx(workbookWith('<worksheet><sheetData/></worksheet>', `<sst>${'<si>'.repeat(N)}`)));
    expect(code).toBe('MALFORMED');
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('refuses tags that never end (no ">") and closing tags that do not match', () => {
    const [code, ms] = timed(() => decodeXlsx(workbookWith(`<worksheet><sheetData>${'<row r="1"'.repeat(N)}`)));
    expect(code).toBe('MALFORMED');
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(codeOf(() => decodeXlsx(workbookWith('<worksheet><sheetData><row></c></row></sheetData></worksheet>')))).toBe('MALFORMED');
    expect(codeOf(() => decodeXlsx(workbookWith('<worksheet><sheetData><row><row></row></row></sheetData></worksheet>')))).toBe('MALFORMED');
  });

  it('refuses a DTD outright', () => {
    expect(codeOf(() => decodeXlsx(workbookWith('<!DOCTYPE x [<!ENTITY a "b">]><worksheet><sheetData/></worksheet>')))).toBe('MALFORMED');
  });

  it('stops reading at the row limit without scanning the rest', () => {
    const rows = Array.from({ length: 50 }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}"><v>${i}</v></c></row>`).join('');
    // Everything after row 10 is garbage the reader never needs to look at.
    const { sheets, truncated } = decodeXlsx(workbookWith(`<worksheet><sheetData>${rows}<row>${'<c>'.repeat(1000)}`), { maxRows: 10 });
    expect(truncated).toBe(true);
    expect(sheets[0]?.rows).toHaveLength(10);
  });
});

// #265 / #273: a shared-string cell is ~20 bytes of XML but expands to the whole string every time
// it is used; the budget is what the reader produces, not what it inflates.
describe('xlsx reader: decoded output is budgeted (#265, #273)', () => {
  const longText = 'Please describe in detail. '.repeat(150); // ~4,000 characters

  /** One sheet of `rows` x `cols` cells, every one a reference to shared string 0. */
  function amplified(rows: number, cols: number): Uint8Array {
    const cells = Array.from({ length: cols }, () => '<c t="s"><v>0</v></c>').join('');
    const sheet = `<worksheet><sheetData>${`<row>${cells}</row>`.repeat(rows)}</sheetData></worksheet>`;
    return workbookWith(sheet, `<sst><si><t>${longText}</t></si></sst>`);
  }

  it('refuses shared-string fan-out past the decoded-character budget, fast', () => {
    // 10,000 x 40 = 400,000 cells x ~4,000 chars = ~1.6 billion characters if it were materialized.
    const wb = amplified(10_000, 40);
    expect(wb.length).toBeLessThan(200_000);
    const [code, ms] = timed(() => decodeXlsx(wb, { maxRows: 20_000 }));
    expect(code).toBe('TOO_LARGE');
    expect(ms).toBeLessThan(1_000);
  });

  it('honours a caller budget on characters and on cells', () => {
    expect(codeOf(() => decodeXlsx(amplified(10, 10), { maxTotalChars: 50_000 }))).toBe('TOO_LARGE');
    expect(codeOf(() => decodeXlsx(amplified(10, 10), { maxTotalChars: 1_000_000 }))).toBe(null);
    expect(codeOf(() => decodeXlsx(amplified(10, 10), { maxCells: 99 }))).toBe('TOO_LARGE');
    expect(codeOf(() => decodeXlsx(amplified(10, 10), { maxCells: 100 }))).toBe(null);
  });

  it('charges padding: a far-right cell costs every empty cell before it', () => {
    const wb = workbookWith('<worksheet><sheetData><row r="1"><c r="CV1"><v>1</v></c></row></sheetData></worksheet>');
    expect(codeOf(() => decodeXlsx(wb, { maxCells: 50 }))).toBe('TOO_LARGE');
    expect(decodeXlsx(wb, { maxCells: 100 }).sheets[0]?.rows[0]).toHaveLength(100);
  });

  it('cuts a cell at maxCellChars and says so', () => {
    const { sheets, truncated } = decodeXlsx(amplified(1, 2), { maxCellChars: 100 });
    expect(truncated).toBe(true);
    expect(sheets[0]?.rows[0]?.[0]).toHaveLength(100);
  });
});

describe('xlsx writer', () => {
  it('round-trips grids, including text that looks like a formula, as inline strings', () => {
    const sheets = [
      { name: 'Answers', rows: [['Question', 'Answer'], ['Do you use MFA?', 'Yes'], ['=cmd|"/c calc"!A1', ' leading space'], [], ['x\ny']] },
      { name: 'Answers', rows: [['dup name']] },
    ];
    const bytes = encodeXlsx(sheets);
    expect(looksLikeXlsx(bytes)).toBe(true);
    const back = decodeXlsx(bytes);
    expect(back.sheets.map((s) => s.name)).toEqual(['Answers', 'Answers (2)']);
    expect(back.sheets[0]?.rows).toEqual([['Question', 'Answer'], ['Do you use MFA?', 'Yes'], ['=cmd|"/c calc"!A1', ' leading space'], [], ['x\ny']]);
    // Never a formula element in what we write.
    const text = new TextDecoder().decode(bytes);
    expect(text.includes('<f>')).toBe(false);
  });

  it('writes deterministic bytes for the same input', () => {
    const a = encodeXlsx([{ name: 'S', rows: [['a']] }]);
    const b = encodeXlsx([{ name: 'S', rows: [['a']] }]);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('cleans sheet names and XML-invalid characters', () => {
    const taken = new Set<string>();
    expect(safeSheetName('Q1/Q2: [draft]*?', taken)).toBe('Q1 Q2   draft');
    expect(safeSheetName('', taken)).toBe('Sheet');
    expect(safeSheetName('x'.repeat(40), taken)).toHaveLength(31);
    expect(escapeXmlText('a\u0001b<c>&"')).toBe('ab&lt;c&gt;&amp;&quot;');
  });

  it('converts column letters both ways', () => {
    expect(columnIndexOf('A1')).toBe(0);
    expect(columnIndexOf('Z9')).toBe(25);
    expect(columnIndexOf('AA10')).toBe(26);
    expect(columnLetters(0)).toBe('A');
    expect(columnLetters(27)).toBe('AB');
    expect(columnIndexOf('12')).toBe(-1);
  });
});

describe('csv grid', () => {
  it('keeps row positions and drops a BOM and the trailing newline', () => {
    expect(decodeCsvGrid('﻿Question,Answer\n\n"Do you, really?",Yes\n')).toEqual([['Question', 'Answer'], [], ['Do you, really?', 'Yes']]);
    expect(decodeCsvGrid('a\tb\n', 'tsv')).toEqual([['a', 'b']]);
  });
});
