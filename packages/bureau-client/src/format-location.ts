/**
 * Human-friendly location labels for the docked box ("Viewing:", "In:").
 *
 * Hosts report locations as {app, url, label} and the quality of `label`
 * varies — some pages send a real title ("Frndo Board"), others fall back
 * to paths or embed UUIDs. Users should never read resource locators:
 * UUIDs, url-surface hashes, and raw paths are data, not labels. This
 * module turns whatever we have into "[Bam] Frndo Board"-shaped text:
 *
 *   - the app id maps to its product name ([b3 → Bam], [brief → Brief], …)
 *   - UUIDs and `u`+16-hex url-surface ids are stripped wherever they
 *     appear
 *   - when only a URL/path is available, the path segments (minus the app
 *     prefix and id-shaped segments) are decoded and title-cased into a
 *     breadcrumb ("Documents › Launch Plan")
 */

const APP_DISPLAY_NAMES: Record<string, string> = {
  b3: 'Bam',
  bam: 'Bam',
  banter: 'Banter',
  beacon: 'Beacon',
  brief: 'Brief',
  bolt: 'Bolt',
  bearing: 'Bearing',
  board: 'Board',
  bond: 'Bond',
  blast: 'Blast',
  bench: 'Bench',
  book: 'Book',
  blank: 'Blank',
  bill: 'Bill',
  blueprint: 'Blueprint',
  helpdesk: 'Helpdesk',
  bureau: 'Bureau',
  url: 'Page',
};

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const URL_SURFACE_RE = /\bu[0-9a-f]{16}\b/gi;

export function appDisplayName(app: string | null | undefined): string {
  if (!app) return '';
  return APP_DISPLAY_NAMES[app.toLowerCase()] ?? app.charAt(0).toUpperCase() + app.slice(1);
}

function stripIds(text: string): string {
  return text.replace(UUID_RE, '').replace(URL_SURFACE_RE, '');
}

function looksLikePath(text: string): boolean {
  return /^(https?:\/\/|\/)/i.test(text.trim());
}

function titleCaseSegment(segment: string): string {
  const words = decodeURIComponentSafe(segment).replace(/[-_]+/g, ' ').trim();
  return words
    .split(/\s+/)
    .map((w) => (w.length > 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Path → breadcrumb: "/b3/projects/<uuid>/dashboard" → "Projects › Dashboard". */
function pathToBreadcrumb(rawUrl: string, app: string | null | undefined): string {
  let path = rawUrl.trim();
  try {
    // Tolerate absolute URLs and bare paths alike.
    path = new URL(rawUrl, 'http://x/').pathname;
  } catch {
    /* keep as-is */
  }
  const segments = path
    .split('/')
    .map((seg) => stripIds(seg).trim())
    .filter((seg) => seg.length > 0)
    // Drop the app prefix segment ("b3", "brief", …) — the [App] tag
    // already says it.
    .filter((seg, i) => !(i === 0 && app && seg.toLowerCase() === app.toLowerCase()))
    .map(titleCaseSegment)
    .filter((seg) => seg.length > 0);
  return segments.join(' › ');
}

/**
 * Best human title for a location. Prefers the host-provided label (with
 * ids stripped); falls back to a path breadcrumb; empty string when
 * nothing presentable remains (caller shows just the app tag).
 */
export function humanizeLocationTitle(
  label: string | null | undefined,
  url: string | null | undefined,
  app?: string | null,
): string {
  if (label && label.trim().length > 0 && !looksLikePath(label)) {
    const cleaned = stripIds(label).replace(/\s{2,}/g, ' ').replace(/[\s/:·–-]+$/g, '').trim();
    if (cleaned.length > 0) return cleaned;
  }
  const source = label && looksLikePath(label) ? label : url;
  if (source && source.trim().length > 0) {
    return pathToBreadcrumb(source, app ?? null);
  }
  return '';
}

/** "[Bam] Frndo Board" — or just "[Bam]" when no presentable title exists. */
export function formatLocationDisplay(
  app: string | null | undefined,
  label: string | null | undefined,
  url: string | null | undefined,
): string {
  const name = appDisplayName(app);
  const title = humanizeLocationTitle(label, url, app);
  if (name && title) return `[${name}] ${title}`;
  if (name) return `[${name}]`;
  return title;
}
