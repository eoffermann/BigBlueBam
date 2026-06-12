/**
 * URL-derived Bureau surfaces — "every place in the suite is a room".
 *
 * Apps that know their content entity report an explicit `surface_id`
 * (a Brief doc id, a Board canvas id, …) and get an entity-scoped
 * huddle room. Every OTHER located page falls back to a surface derived
 * from its URL: the bureau-client SDK hashes the normalized path into a
 * synthetic surface id (`surface_app: 'url'`), so two people on the
 * same page in the same org always land in the same call room.
 *
 * This module is the SINGLE implementation of that derivation, shared
 * by the client (which derives from window.location to pick its room)
 * and bureau-api (which re-derives from the presence session's stored
 * locationUrl to verify a token mint — the symmetric-auth check). The
 * two sides MUST agree byte-for-byte, which is why this lives in
 * @bigbluebam/shared and not in either consumer.
 *
 * Normalization: scheme/host/query/fragment are dropped — the room is
 * keyed on the decoded, lowercased pathname with the trailing slash
 * stripped. Query params intentionally do NOT split rooms (most suite
 * URLs are path-routed; a `?tab=` toggle shouldn't strand two people
 * in different rooms on the same document). Org separation is applied
 * server-side: the minted LiveKit room is `huddle-url-{orgId}-{id}`,
 * so the same path in two orgs can never share a room.
 */

/** Pseudo surface_app for URL-derived rooms. */
export const URL_SURFACE_APP = 'url';

/** 32-bit FNV-1a — tiny, dependency-free, stable across JS engines. */
function fnv1a32(input: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // hash *= 16777619 (FNV prime), in 32-bit space without BigInt.
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash >>> 0;
}

/** Normalized room key for a URL: decoded lowercase pathname, no trailing slash. */
export function normalizeSurfacePath(rawUrl: string): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let pathname: string;
  try {
    // Base handles path-only inputs ('/b3/projects/…').
    pathname = new URL(rawUrl, 'http://bureau.invalid').pathname;
  } catch {
    return null;
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    decoded = pathname; // malformed escapes: hash the raw form consistently
  }
  let normalized = decoded.toLowerCase();
  while (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized || '/';
}

/**
 * Derive the synthetic surface id for a URL: `u` + 16 hex chars (two
 * independently-seeded 32-bit FNV-1a hashes of the normalized path).
 * Deterministic, lowercase, and conformant to the bureau-api
 * surface_id slug rules (`[a-z0-9][a-z0-9-]{0,63}`). Returns null when
 * the input can't be normalized.
 */
export function deriveUrlSurfaceId(rawUrl: string): string | null {
  const path = normalizeSurfacePath(rawUrl);
  if (path === null) return null;
  const a = fnv1a32(path, 0x811c9dc5); // standard FNV offset basis
  const b = fnv1a32(`bbb:${path}`, 0x01000193); // FNV prime as alt seed
  return `u${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}
