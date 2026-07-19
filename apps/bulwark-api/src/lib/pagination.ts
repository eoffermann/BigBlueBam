import { and, lt, or, eq, desc, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';

// Cursor-based pagination on the platform convention (created_at DESC, id DESC keyset).
// The cursor is an opaque base64 of "<created_at ISO>|<id>". A stable secondary sort on id
// breaks ties so no row is skipped or repeated across pages.

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
    return { createdAt: decoded.slice(0, sep), id: decoded.slice(sep + 1) };
  } catch {
    return null;
  }
}

// A keyset WHERE predicate for (created_at, id) < (cursor.created_at, cursor.id).
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
