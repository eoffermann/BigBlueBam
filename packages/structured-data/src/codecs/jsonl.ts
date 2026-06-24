import type { DecodeResult, JsonlDialect } from '../types.js';

export function decodeJsonl(text: string): DecodeResult {
  const newline: '\n' | '\r\n' = text.includes('\r\n') ? '\r\n' : '\n';
  const rows = text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  const dialect: JsonlDialect = { newline, trailingNewline: /\r?\n$/.test(text) };
  return { format: 'jsonl', data: rows, dialect: { format: 'jsonl', ...dialect } };
}

export function encodeJsonl(rows: unknown[], dialect: JsonlDialect): string {
  const body = rows.map((r) => JSON.stringify(r)).join(dialect.newline);
  return dialect.trailingNewline ? `${body}${dialect.newline}` : body;
}
