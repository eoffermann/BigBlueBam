// CSV formula-injection neutralization + safe row/field serialization.
//
// SHARED because two Bursar exports (GET /spend/export and GET /requests/:id/diff/export) both
// emit user-influenced strings (payee names, vendor labels, scope-node titles) into a CSV a CFO
// will open in Excel/Sheets. A cell beginning with `=`, `+`, `-`, or `@` is interpreted by the
// spreadsheet as a FORMULA, so a crafted payee like `=cmd|'/c calc'!A1` becomes code execution
// on open. This is CWE-1236. Neutralizing in ONE shared helper means a new export surface cannot
// forget it (the mirror of burn's redact-financial-fields placement).
//
// This module is a PURE function with no node imports, so it is safe to re-export from the
// browser-facing barrel (index.ts); a client-side preview of a CSV can neutralize identically.

// The four spreadsheet formula-trigger prefixes, plus tab and carriage-return, which some
// spreadsheet importers also treat as leading formula/whitespace tricks (OWASP CSV-injection).
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Neutralize a single field value so a spreadsheet cannot interpret it as a formula, THEN escape
 * it for CSV structure. The neutralization prepends a single apostrophe (the spreadsheet
 * convention for "this is text, not a formula") when the value begins with a trigger character.
 * The CSV escaping wraps the field in double quotes and doubles any embedded quote when the value
 * contains a comma, quote, CR, or LF.
 *
 * Numbers and booleans are rendered without neutralization (a bare number is never a formula), but
 * still pass through CSV escaping. `null`/`undefined` become an empty field.
 */
export function neutralizeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s = typeof value === 'string' ? value : String(value);
  // Formula neutralization applies only to string-origin values that begin with a trigger. A
  // numeric/boolean coercion like "-5" from a real number is left alone below via the typeof gate.
  if (typeof value === 'string' && s.length > 0 && FORMULA_TRIGGERS.has(s[0]!)) {
    s = `'${s}`;
  }
  // CSV structural escaping: quote when the field contains a delimiter, quote, or newline.
  if (/[",\r\n]/.test(s)) {
    s = `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

/** Serialize one row: neutralize + escape each field, join with commas. */
export function toCsvRow(fields: readonly unknown[]): string {
  return fields.map(neutralizeCsvField).join(',');
}

/**
 * Build a full CSV document from a header and rows. Uses CRLF line endings (RFC 4180) so the file
 * opens cleanly in Excel on every platform. Every field passes through neutralizeCsvField, so no
 * caller can bypass the formula guard by writing a raw row.
 */
export function toCsv(header: readonly unknown[], rows: readonly (readonly unknown[])[]): string {
  const lines = [toCsvRow(header), ...rows.map(toCsvRow)];
  return lines.join('\r\n');
}
