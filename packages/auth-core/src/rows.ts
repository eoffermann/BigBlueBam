/** Rows from a drizzle `db.execute` result, which is either a row array or `{ rows }`. */
export function rowsOf(raw: unknown): Array<Record<string, unknown>> {
  return (Array.isArray(raw) ? raw : ((raw as { rows?: unknown[] } | null)?.rows ?? [])) as Array<
    Record<string, unknown>
  >;
}
