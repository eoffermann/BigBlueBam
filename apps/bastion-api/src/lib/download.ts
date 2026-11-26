// Byte responses (spec 5.1 "Byte responses"): every Bastion download is an attachment, sandboxed,
// never sniffed, and served with an allowlisted content type (anything else is
// application/octet-stream). Pure, so the header set is unit-tested.

export const BASTION_DOWNLOAD_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'application/pdf',
  'text/plain',
  'text/csv',
  'application/json',
  'image/png',
  'image/jpeg',
  'application/zip',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

/** The served content type: the stored one when allowlisted (parameters dropped), else octet-stream. */
export function servedContentType(stored: string | null | undefined): string {
  const base = ((stored ?? '').split(';')[0] ?? '').trim().toLowerCase();
  if (!BASTION_DOWNLOAD_CONTENT_TYPES.has(base)) return 'application/octet-stream';
  return base.startsWith('text/') ? `${base}; charset=utf-8` : base;
}

/** A filename safe for Content-Disposition: printable ASCII, no quotes or path separators. */
export function safeFilename(name: string, fallback = 'evidence'): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\/:*?<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : fallback;
}

/** The full header set for one download. */
export function downloadHeaders(opts: { contentType: string | null | undefined; filename: string; size?: number | null }): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': servedContentType(opts.contentType),
    'Content-Disposition': `attachment; filename="${safeFilename(opts.filename)}"`,
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, no-store',
  };
  if (typeof opts.size === 'number' && Number.isFinite(opts.size) && opts.size >= 0) headers['Content-Length'] = String(opts.size);
  return headers;
}
