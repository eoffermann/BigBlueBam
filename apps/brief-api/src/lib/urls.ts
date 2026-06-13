// ---------------------------------------------------------------------------
// URL builders for deep-links into the Brief SPA.
//
// Used by Bolt event payloads and anywhere else we need to hand off a
// canonical link to a Brief entity. The base URL comes from env.PUBLIC_URL
// (default `http://localhost`) with the `/brief` app mount suffix appended.
// ---------------------------------------------------------------------------

const DEFAULT_BASE = 'http://localhost';
const BRIEF_PATH = '/brief';

function root(): string {
  const raw = process.env.PUBLIC_URL || DEFAULT_BASE;
  return raw.replace(/\/$/, '');
}

function base(): string {
  return `${root()}${BRIEF_PATH}`;
}

/** Deep-link to the read-only document detail page. */
export function documentUrl(idOrSlug: string): string {
  return `${base()}/documents/${idOrSlug}`;
}

/** Deep-link to the document editor page. */
export function documentEditUrl(idOrSlug: string): string {
  return `${base()}/documents/${idOrSlug}/edit`;
}
