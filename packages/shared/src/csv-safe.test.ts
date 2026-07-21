import { describe, it, expect } from 'vitest';
import { neutralizeCsvField, neutralizeCsvValue, toCsvRow, toCsv } from './csv-safe.js';

describe('neutralizeCsvField', () => {
  it('prefixes an apostrophe to a formula-triggering leading =', () => {
    expect(neutralizeCsvField('=1+1')).toBe("'=1+1");
  });

  it('neutralizes each of the four leading triggers = + - @', () => {
    expect(neutralizeCsvField('=SUM(A1:A9)')).toBe("'=SUM(A1:A9)");
    expect(neutralizeCsvField('+1')).toBe("'+1");
    expect(neutralizeCsvField('-1')).toBe("'-1");
    expect(neutralizeCsvField('@import')).toBe("'@import");
  });

  it('neutralizes the classic command-injection payee', () => {
    // A payee crafted to execute on open must be defanged.
    expect(neutralizeCsvField("=cmd|'/c calc'!A1")).toBe("'=cmd|'/c calc'!A1");
  });

  it('neutralizes leading tab and carriage return', () => {
    // A leading tab triggers the apostrophe prefix but a bare tab is not a CSV structural char,
    // so it is not quote-wrapped. A CR both triggers the prefix AND forces quote-wrapping.
    expect(neutralizeCsvField('\t=1')).toBe("'\t=1");
    expect(neutralizeCsvField('\r=1')).toBe(`"'\r=1"`);
  });

  it('leaves a benign string untouched', () => {
    expect(neutralizeCsvField('Acme Widgets')).toBe('Acme Widgets');
  });

  it('does NOT neutralize a real negative number (numeric origin)', () => {
    // A number is never a formula; only string-origin values beginning with a trigger get quoted.
    expect(neutralizeCsvField(-25)).toBe('-25');
    expect(neutralizeCsvField(0)).toBe('0');
  });

  it('CSV-escapes commas, quotes, and newlines', () => {
    expect(neutralizeCsvField('a,b')).toBe('"a,b"');
    expect(neutralizeCsvField('say "hi"')).toBe('"say ""hi"""');
    expect(neutralizeCsvField('line1\nline2')).toBe('"line1\nline2"');
  });

  it('renders null and undefined as empty fields', () => {
    expect(neutralizeCsvField(null)).toBe('');
    expect(neutralizeCsvField(undefined)).toBe('');
  });
});

describe('neutralizeCsvValue (neutralize only, no structural escaping)', () => {
  it('prefixes an apostrophe to each leading trigger but does NOT quote-wrap', () => {
    expect(neutralizeCsvValue('=1+1')).toBe("'=1+1");
    expect(neutralizeCsvValue('+1')).toBe("'+1");
    expect(neutralizeCsvValue('-1')).toBe("'-1");
    expect(neutralizeCsvValue('@x')).toBe("'@x");
  });

  it('does not add structural quotes even when the value contains a comma or quote', () => {
    // This is the whole point: callers that do their own quoting must not get double-escaped.
    expect(neutralizeCsvValue('a,b')).toBe('a,b');
    expect(neutralizeCsvValue('=a,b')).toBe("'=a,b");
    expect(neutralizeCsvValue('say "hi"')).toBe('say "hi"');
  });

  it('leaves benign strings and numeric-origin values untouched', () => {
    expect(neutralizeCsvValue('Acme')).toBe('Acme');
    expect(neutralizeCsvValue(-25)).toBe('-25');
    expect(neutralizeCsvValue(null)).toBe('');
  });
});

describe('toCsvRow / toCsv', () => {
  it('joins neutralized fields with commas', () => {
    expect(toCsvRow(['Acme', '=EVIL', 100])).toBe("Acme,'=EVIL,100");
  });

  it('builds a CRLF-delimited document with a header', () => {
    const csv = toCsv(['payee', 'amount'], [['Acme', 100], ['=BAD', 25]]);
    expect(csv).toBe("payee,amount\r\nAcme,100\r\n'=BAD,25");
  });
});
