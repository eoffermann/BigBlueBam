import type { DecodeResult, JsonDialect } from '../types.js';

/** Detect the indent unit used by a pretty-printed JSON source so we can replay
 *  it on encode. Returns 0 for minified (no newline-led indentation). */
export function detectJsonIndent(text: string): number | '\t' {
  // First newline followed by leading whitespace before a non-space char.
  const m = text.match(/\n([ \t]+)\S/);
  if (!m) return 0;
  const ws = m[1]!;
  if (ws[0] === '\t') return '\t';
  return ws.length;
}

export function decodeJson(text: string): DecodeResult {
  const data = JSON.parse(text);
  const dialect: JsonDialect = {
    indent: detectJsonIndent(text),
    trailingNewline: text.endsWith('\n'),
  };
  return { format: 'json', data, dialect: { format: 'json', ...dialect } };
}

export function encodeJson(data: unknown, dialect: JsonDialect): string {
  const indent = dialect.indent === 0 ? undefined : dialect.indent;
  const body = JSON.stringify(data, null, indent as number | string | undefined);
  return dialect.trailingNewline ? `${body}\n` : body;
}
