import { and, lt, or, eq, desc, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

// Cursor-based pagination on the platform convention (created_at DESC, id DESC keyset).
// The cursor is an opaque base64url of "<created_at ISO>|<id>". The stable secondary sort on
// id breaks ties so no row is skipped or repeated across pages.

export interface Cursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(createdAt: Date | string, id: string): string {
  const iso = createdAt instanceof Date ? createdAt.toISOString() : createdAt;
  return Buffer.from(`${iso}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const sep = decoded.lastIndexOf('|');
    if (sep <= 0) return null;
    const when = decoded.slice(0, sep);
    if (Number.isNaN(new Date(when).getTime())) return null;
    return { createdAt: when, id: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

export function keysetPredicate(
  createdAtCol: PgColumn,
  idCol: PgColumn,
  cursor: Cursor | null,
): SQL | undefined {
  if (!cursor) return undefined;
  return or(
    lt(createdAtCol, new Date(cursor.createdAt)),
    and(eq(createdAtCol, new Date(cursor.createdAt)), lt(idCol, cursor.id)),
  );
}

export const keysetOrder = (createdAtCol: PgColumn, idCol: PgColumn) => [
  desc(createdAtCol),
  desc(idCol),
];

/** Slice an over-fetched page (limit + 1) into rows plus the next cursor. */
export function pageOf<T extends { id: string; created_at: Date | string }>(
  rows: T[],
  limit: number,
): { rows: T[]; next_cursor: string | null } {
  if (rows.length <= limit) return { rows, next_cursor: null };
  const page = rows.slice(0, limit);
  const last = page[page.length - 1]!;
  return { rows: page, next_cursor: encodeCursor(last.created_at, last.id) };
}
