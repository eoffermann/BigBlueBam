// What a pasted suite link names (#232, #239). People copy the address bar from the app that owns
// a thing, so a link is the normal input wherever Bastion asks "which one?"; a bare id still
// works. One parser per app, here, so the SPA and bastion-api read links the same way and no page
// ever asks a person for a raw id (the #219 Bin field, the #232 Review queue, the #239 Policies
// page). Pure; browser-safe.
//
//   bin     /bin/assets/<id>, or a /bin link with ?asset= / ?asset_id= / ?id=
//   bolt    /bolt/automations/<id>[/executions]
//   beacon  /beacon/<id or slug>[/edit]   (Beacon links use the slug when an article has one)

export type SuiteLinkApp = 'bin' | 'bolt' | 'beacon';

/** An id, or (Beacon only) a slug the server resolves to an id. */
export type SuiteLinkRef = { id: string } | { slug: string };

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const BARE_UUID = new RegExp(`^${UUID.source}$`, 'i');
/** Beacon slugs: lowercase words joined by hyphens (beacon-api's slugify). */
export const BEACON_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Beacon SPA pages that are not articles. */
const BEACON_PAGES = new Set(['list', 'search', 'create', 'dashboard', 'settings', 'graph']);

/** Plain-words refusals, for a field that could not read the paste. */
export const SUITE_LINK_REFUSAL: Record<SuiteLinkApp, string> = {
  bin: "That doesn't look like a Bin file link. Open the file in Bin, copy the address from your browser, and paste it here.",
  bolt: "That doesn't look like a Bolt automation link. Open the automation in Bolt, copy the address from your browser, and paste it here.",
  beacon: "That doesn't look like a Beacon article link. Open the article in Beacon, copy the address from your browser, and paste it here.",
};

function decoded(segment: string | undefined): string {
  try {
    return decodeURIComponent(segment ?? '');
  } catch {
    return '';
  }
}

/** What a pasted link (or bare id) names in `app`, or null when it names nothing there. */
export function suiteLinkRef(input: string, app: SuiteLinkApp): SuiteLinkRef | null {
  const text = input.trim();
  if (!text) return null;
  if (BARE_UUID.test(text)) return { id: text.toLowerCase() };
  let url: URL;
  try {
    url = new URL(text, 'http://suite.invalid');
  } catch {
    return null;
  }
  const path = url.pathname;
  if (app === 'bin') {
    // The app may sit under a prefix, so match the tail.
    const m = /\/bin\/assets\/([^/?#]+)\/?$/i.exec(path);
    const id = decoded(m?.[1]);
    if (m && BARE_UUID.test(id)) return { id: id.toLowerCase() };
    if (/\/bin(\/|$)/i.test(path)) {
      for (const key of ['asset', 'asset_id', 'id']) {
        const v = url.searchParams.get(key);
        if (v && BARE_UUID.test(v)) return { id: v.toLowerCase() };
      }
    }
    return null;
  }
  if (app === 'bolt') {
    const m = /\/bolt\/automations\/([^/?#]+)(?:\/executions)?\/?$/i.exec(path);
    const id = decoded(m?.[1]);
    return m && BARE_UUID.test(id) ? { id: id.toLowerCase() } : null;
  }
  const m = /\/beacon\/([^/?#]+)(?:\/edit)?\/?$/i.exec(path);
  const seg = decoded(m?.[1]);
  if (!m || !seg || BEACON_PAGES.has(seg.toLowerCase())) return null;
  if (BARE_UUID.test(seg)) return { id: seg.toLowerCase() };
  const slug = seg.toLowerCase();
  return BEACON_SLUG.test(slug) && slug.length <= 256 ? { slug } : null;
}

/** The id a pasted link names, or null (a Beacon slug link is not an id; use suiteLinkRef). */
export function suiteLinkId(input: string, app: SuiteLinkApp): string | null {
  const ref = suiteLinkRef(input, app);
  return ref && 'id' in ref ? ref.id : null;
}
