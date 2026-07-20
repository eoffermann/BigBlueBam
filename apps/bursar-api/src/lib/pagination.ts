// Cursor pagination helpers. Keyset on (created_at DESC, id DESC), encoded as an opaque
// base64 token so the client treats it as a handle. Shared by every bursar list endpoint.

export interface Cursor {
  createdAt: string;
  id: string;
}

export function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.createdAt}|${c.id}`, 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const idx = decoded.lastIndexOf('|');
    if (idx < 0) return null;
    const createdAt = decoded.slice(0, idx);
    const id = decoded.slice(idx + 1);
    if (!createdAt || !id) return null;
    // Validate the timestamp so a garbled cursor is ignored rather than throwing in SQL.
    if (Number.isNaN(new Date(createdAt).getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Slice an over-fetched page (limit + 1 rows). Returns the trimmed rows and the next cursor,
 * or null when there is no further page.
 */
export function paginate<T extends { id: string; created_at: Date | string }>(
  rows: T[],
  limit: number,
): { items: T[]; next_cursor: string | null } {
  if (rows.length <= limit) return { items: rows, next_cursor: null };
  const items = rows.slice(0, limit);
  const last = items[items.length - 1]!;
  const createdAt =
    last.created_at instanceof Date ? last.created_at.toISOString() : String(last.created_at);
  return { items, next_cursor: encodeCursor({ createdAt, id: last.id }) };
}
