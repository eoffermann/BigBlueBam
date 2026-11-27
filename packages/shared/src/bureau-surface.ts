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

/**
 * The entity-scoped Bureau surfaces (issue #161): the apps whose pages report
 * an explicit `surface_id`, so a user can ring someone onto that surface and
 * mint a surface huddle for it. A curated subset of the Launchpad apps, NOT a
 * roster: an app joins this list only once its pages advertise a surface id.
 * The receiver resolves each (app, id) to a URL, so a new entry also needs a
 * resolver on the client side.
 *
 * - banter: surface_id is the channel id; resolved via /banter/go/:channelId.
 * - book: surface_id is the event id; the event's meeting_url deep-links to
 *   /book/events/:id and the docked box joins huddle-book-{eventId}.
 *
 * Single source for bureau-api's ring and huddle-token routes and for the
 * bureau-client Invite button's location-app mapping.
 */
export const BUREAU_ENTITY_SURFACE_APPS = [
  'brief',
  'blueprint',
  'board',
  'bond',
  'bam',
  'beacon',
  'helpdesk',
  'banter',
  'book',
] as const;

/**
 * Every surface_app bureau-api accepts on ring and surface-huddle routes: the
 * entity surfaces plus the URL-derived pseudo surface. The URL room is
 * org-scoped at mint time because URL paths are not unique across tenants.
 */
export const BUREAU_SURFACE_APPS = [...BUREAU_ENTITY_SURFACE_APPS, URL_SURFACE_APP] as const;

export type BureauSurfaceApp = (typeof BUREAU_SURFACE_APPS)[number];

/**
 * The ring surface_app for a bureau-client `location.app` (Bam reports `b3`
 * or `bam`), or undefined when the app has no entity surface, in which case
 * the client shows no Invite button because the ring route would reject it.
 */
export function bureauSurfaceAppForLocationApp(app: string | null | undefined): BureauSurfaceApp | undefined {
  if (!app) return undefined;
  const normalized = app === 'b3' ? 'bam' : app;
  return (BUREAU_ENTITY_SURFACE_APPS as readonly string[]).includes(normalized)
    ? (normalized as BureauSurfaceApp)
    : undefined;
}

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
