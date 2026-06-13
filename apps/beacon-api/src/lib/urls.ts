// ---------------------------------------------------------------------------
// URL builders for deep-links into the Beacon SPA.
//
// Used by Bolt event payloads and anywhere else we need to hand a user
// (or an automation rule) a canonical link to a Beacon entry. The base URL
// is env.PUBLIC_URL (the bare site root) with the `/beacon` SPA mount appended.
// ---------------------------------------------------------------------------

import { env } from '../env.js';

function base(): string {
  return `${env.PUBLIC_URL.replace(/\/$/, '')}/beacon`;
}

/**
 * Deep-link to a Beacon entry. Prefers slug (human-readable, stable across
 * edits) and falls back to UUID.
 */
export function beaconUrl(slugOrId: string): string {
  return `${base()}/${slugOrId}`;
}
