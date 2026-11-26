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
