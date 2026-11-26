// Opaque keyset cursors for Bastion's list endpoints (issues #193 and #204). A cursor names the
// last row of a page; the page boundary is read back from that row in SQL, so microsecond
// timestamps never lose precision through JavaScript. A cursor that does not decode is a 400
// with a plain message, never a silent first page.

import { ValidationFailure } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function invalid(): never {
  throw new ValidationFailure('That page link is no longer valid. Start from the first page.', 'INVALID_CURSOR', [
    { field: 'cursor', issue: 'invalid' },
  ]);
}

function decode(cursor: string, shape: RegExp): string {
  let value: string;
  try {
    value = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    invalid();
  }
  if (!shape.test(value)) invalid();
  return value;
}

/** Cursor over a row id (rows ordered by (created_at, id) or similar, read back by id). */
export const encodeIdCursor = (id: string): string => Buffer.from(id, 'utf8').toString('base64url');
export const decodeIdCursor = (cursor: string): string => decode(cursor, UUID_RE);

/** Cursor over a calendar date key (seals are unique per (org, seal_date)). */
export const encodeDateCursor = (date: string): string => Buffer.from(date, 'utf8').toString('base64url');
export const decodeDateCursor = (cursor: string): string => decode(cursor, DATE_RE);

/** Fetch limit + 1 rows, then split into the page and its continuation. */
export function pageOf<T>(rows: readonly T[], limit: number, cursorOf: (last: T) => string) {
  const page = rows.slice(0, limit);
  const has_more = rows.length > limit;
  const last = page[page.length - 1];
  return { data: page, has_more, next_cursor: has_more && last !== undefined ? cursorOf(last) : null };
}
