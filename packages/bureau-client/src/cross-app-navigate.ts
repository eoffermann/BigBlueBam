/**
 * crossAppNavigate — SPA-boundary-aware navigation for the SDK.
 *
 * Every host SPA's `navigate` adapter is pushState + a synthetic
 * popstate: perfect for routes INSIDE that SPA, physically incapable of
 * loading a DIFFERENT app's bundle. An invite/summon/hunt that points
 * at another app (`/banter/… → /b3/…`) therefore used to update the URL
 * bar and render nothing — the destination app never loaded (Railway
 * invite testing, 2026-06-12).
 *
 * This wrapper is the single choke point through which every SDK
 * navigation flows (ring accept, summon join, hunt jump, force-invite
 * pull): same-app targets go through the host adapter as before;
 * cross-app or cross-origin targets get a real document load.
 *
 * The "app" is the first path segment (`/b3/…` → `b3`), matching how
 * nginx mounts the suite's SPAs.
 */

export function firstPathSegment(pathname: string): string {
  return pathname.split('/').filter(Boolean)[0] ?? '';
}

export function crossAppNavigate(
  hostNavigate: (url: string) => void,
  rawUrl: string,
  // Injectable for tests — jsdom's window.location is non-configurable.
  assign: (url: string) => void = (url) => window.location.assign(url),
): void {
  try {
    const target = new URL(rawUrl, window.location.href);

    // Different origin: nothing the host router could ever do.
    if (target.origin !== window.location.origin) {
      assign(target.toString());
      return;
    }

    const relative = target.pathname + target.search + target.hash;

    // Crossing an SPA boundary: pushState can't load the other app's
    // bundle — a full document load is the only correct move. The
    // destination SPA boots, its bureau-client mounts, presence
    // updates, and the docked box auto-joins the destination room.
    if (firstPathSegment(target.pathname) !== firstPathSegment(window.location.pathname)) {
      assign(relative);
      return;
    }

    // Same app: the host's router owns it (no reload, state preserved).
    hostNavigate(relative);
  } catch {
    // Unparseable input — let the host adapter take its own shot (its
    // catch-branches typically fall back to location.href themselves).
    hostNavigate(rawUrl);
  }
}
