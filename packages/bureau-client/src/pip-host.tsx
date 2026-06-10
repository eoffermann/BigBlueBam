/**
 * pip-host.tsx — Document Picture-in-Picture host for the docked Bureau box.
 *
 * Design doc §5.1 calls out three render targets for the floating box:
 *   1. Docked panel — rendered in-page (default, all browsers).
 *   2. Document PiP — an always-on-top OS-managed window (Chromium 116+).
 *   3. Tauri native window — later workstream.
 *
 * This module implements (2). The contract is intentionally narrow:
 *
 *   - `openPipWindow()` requests a Document PiP window from the browser,
 *     clones the host document's stylesheets into the PiP <head> so Tailwind
 *     and any other CSS keeps working, then renders the same <BureauDockedBox/>
 *     React tree into the PiP body via createPortal. Because createPortal
 *     preserves React context across DOM trees, the BureauContext provider
 *     in the host SPA reaches the PiP UI without any extra plumbing.
 *
 *   - `<PopoutBureauButton/>` is a small toggle the docked box renders in its
 *     top-right corner. It hides itself on browsers without the API, so the
 *     SDK stays a no-op on Firefox/Safari.
 *
 *   - `usePipMode()` exposes the current target ('inline' | 'pip') so the
 *     inline docked box can collapse to a placeholder while the PiP window
 *     owns the real UI, and auto-restore when the PiP window closes.
 *
 * Lifecycle:
 *
 *   inline ──(user clicks Pop out)──▶ pip ──(pagehide on PiP window)──▶ inline
 *
 * Pagehide fires on the PiP window when the user closes it, when the opener
 * page navigates, and when BFCache stashes either window — for our purposes
 * all three should restore the inline box, so we treat 'pagehide' as the
 * canonical close signal.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { BureauPipMode } from './types.js';

// ─────────────────────────────────────────────────────────────────────────
// Module-level subscribable PiP state.
//
// Why module-level: the docked-box tree (inline) and the PiP-portal tree
// share React context already (createPortal preserves it), but they need
// to coordinate on a SINGLE truth for "are we in PiP mode right now?" so
// that:
//   - The inline tree collapses to a placeholder when pip mode is on.
//   - Repeated clicks on the popout button don't open a second window.
//   - Closing the PiP window flips inline mode back on.
// React doesn't give us a clean cross-tree signal that survives portal
// boundaries other than context, and we'd rather not require the host SPA
// to wrap the SDK in yet another provider. A module-level subscribable
// atom + a useSyncExternalStore-like hook is the simplest path.
// ─────────────────────────────────────────────────────────────────────────

interface PipState {
  mode: BureauPipMode;
  /** The PiP Window, or null when inline. */
  win: Window | null;
  /**
   * The mount node inside the PiP window's body that React portals into.
   * We keep a reference so we can tear it down deterministically.
   */
  mount: HTMLElement | null;
}

const state: PipState = { mode: 'inline', win: null, mount: null };
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) {
    try {
      fn();
    } catch (err) {
      // Subscribers shouldn't throw; log and continue.
      // eslint-disable-next-line no-console
      console.warn('[bureau-client] pip subscriber threw', err);
    }
  }
}

function setState(patch: Partial<PipState>): void {
  Object.assign(state, patch);
  notify();
}

/**
 * Subscribe to PiP-mode changes. Returns an unsubscribe function.
 * Intended for advanced hosts; most callers should use `usePipMode()`.
 */
export function subscribeToPipMode(listener: () => void): () => void {
  subscribers.add(listener);
  return () => {
    subscribers.delete(listener);
  };
}

/** Snapshot accessor for the current PiP state. */
export function getPipMode(): BureauPipMode {
  return state.mode;
}

// ─────────────────────────────────────────────────────────────────────────
// Browser capability detection.
// ─────────────────────────────────────────────────────────────────────────

/**
 * True when the current browser exposes `window.documentPictureInPicture`.
 * Chromium 116+ ships it; Firefox and Safari do not as of 2026-Q2.
 */
export function isDocumentPipSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.documentPictureInPicture !== 'undefined' &&
    typeof window.documentPictureInPicture.requestWindow === 'function'
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Stylesheet replication.
//
// The PiP window opens with an empty <head>. Tailwind, fonts, and any other
// CSS the host SPA loaded will not apply until we copy them in. We do this
// in three passes because there are three sources of style in a typical
// React app:
//
//   1. <link rel="stylesheet"> tags — easy: clone the node, point href at
//      the absolute URL so relative refs still resolve.
//   2. <style> tags (used by Vite dev-mode HMR + emotion/styled-components
//      style injection) — clone the node and its textContent.
//   3. Constructed CSSStyleSheet objects on document.adoptedStyleSheets
//      (Tailwind v4 uses this in some bundles) — we'd ideally adopt them
//      onto the PiP document too, but the DOM spec disallows adopting a
//      stylesheet constructed in one Realm into a Document in another.
//      As a fallback we serialize their cssText into a <style> node.
//
// Pass 3 is best-effort because reading cssText on a stylesheet loaded
// cross-origin throws SecurityError. We swallow those.
// ─────────────────────────────────────────────────────────────────────────

function cloneStylesheets(source: Document, target: Document): void {
  // (1) <link rel="stylesheet">
  const links = source.querySelectorAll('link[rel="stylesheet"]');
  links.forEach((node) => {
    const link = node as HTMLLinkElement;
    const copy = target.createElement('link');
    copy.rel = 'stylesheet';
    if (link.href) copy.href = link.href; // .href is already absolute
    if (link.media) copy.media = link.media;
    if (link.crossOrigin) copy.crossOrigin = link.crossOrigin;
    target.head.appendChild(copy);
  });

  // (2) <style> tags
  const styles = source.querySelectorAll('style');
  styles.forEach((node) => {
    const style = node as HTMLStyleElement;
    const copy = target.createElement('style');
    if (style.media) copy.media = style.media;
    copy.textContent = style.textContent ?? '';
    target.head.appendChild(copy);
  });

  // (3) document.adoptedStyleSheets — best-effort.
  const adopted = (source as Document & { adoptedStyleSheets?: CSSStyleSheet[] })
    .adoptedStyleSheets;
  if (adopted && adopted.length > 0) {
    let cssText = '';
    for (const sheet of adopted) {
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          cssText += `${rule.cssText}\n`;
        }
      } catch {
        // Cross-origin or otherwise unreadable; skip silently.
      }
    }
    if (cssText.length > 0) {
      const copy = target.createElement('style');
      copy.setAttribute('data-bureau-pip-adopted', '');
      copy.textContent = cssText;
      target.head.appendChild(copy);
    }
  }

  // Baseline reset so the PiP window doesn't get the browser's default
  // 8px body margin on top of whatever the host pages also reset.
  const reset = target.createElement('style');
  reset.setAttribute('data-bureau-pip-reset', '');
  reset.textContent =
    'html,body{margin:0;padding:0;background:transparent;color-scheme:dark light;}';
  target.head.appendChild(reset);
}

// ─────────────────────────────────────────────────────────────────────────
// openPipWindow / closePipWindow — the imperative API.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Opens a Document Picture-in-Picture window and switches the SDK into
 * 'pip' mode. Returns the opened Window (or null on no-op / unsupported).
 *
 * Idempotent: a second call while already in pip mode is a no-op and
 * returns the existing window.
 *
 * The window opens at a fixed size matching the docked box; the per-call
 * width/height hints were removed with the draggable/collapsible docked
 * box (Bureau todo #5) — PiP is now the secondary surface and hosts don't
 * size it.
 *
 * The caller is NOT required to clean up — the PiP window emits 'pagehide'
 * when closed, and we restore inline mode automatically. closePipWindow()
 * is exposed for hosts that want to force the window shut (e.g. on logout).
 */
export async function openPipWindow(): Promise<Window | null> {
  if (!isDocumentPipSupported()) return null;
  if (state.mode === 'pip' && state.win) return state.win;

  const api = window.documentPictureInPicture;
  if (!api) return null;

  let pipWindow: Window;
  try {
    pipWindow = await api.requestWindow({ width: 280, height: 360 });
  } catch (err) {
    // User dismissed the prompt, or the browser refused (e.g. no user
    // activation). Stay inline.
    // eslint-disable-next-line no-console
    console.warn('[bureau-client] documentPictureInPicture.requestWindow rejected', err);
    return null;
  }

  // Replicate styles before mounting React, otherwise there will be a
  // flash of unstyled content.
  try {
    cloneStylesheets(document, pipWindow.document);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[bureau-client] failed to clone stylesheets into PiP window', err);
  }

  // Title + favicon for OS taskbar / window-list ergonomics.
  pipWindow.document.title = 'Bureau';

  const mount = pipWindow.document.createElement('div');
  mount.setAttribute('data-bureau-pip-mount', '');
  // Fill the PiP window: the box's own styles control the final size, but
  // the mount itself should not constrain it.
  mount.style.position = 'fixed';
  mount.style.inset = '0';
  mount.style.display = 'flex';
  mount.style.alignItems = 'flex-end';
  mount.style.justifyContent = 'flex-end';
  pipWindow.document.body.appendChild(mount);

  // Listen for the user closing the PiP window. 'pagehide' fires reliably
  // on close in Chromium; we also listen on 'unload' as a belt-and-braces
  // fallback for older builds.
  const handleClose = (): void => {
    if (state.win === pipWindow) {
      setState({ mode: 'inline', win: null, mount: null });
    }
  };
  pipWindow.addEventListener('pagehide', handleClose, { once: true });
  pipWindow.addEventListener('unload', handleClose, { once: true });

  setState({ mode: 'pip', win: pipWindow, mount });
  return pipWindow;
}

/**
 * Force the PiP window closed (if open). Safe to call when already inline.
 */
export function closePipWindow(): void {
  const win = state.win;
  if (!win) {
    setState({ mode: 'inline', win: null, mount: null });
    return;
  }
  try {
    win.close();
  } catch {
    /* ignore */
  }
  // The pagehide listener will flip state back; do it eagerly too so callers
  // see consistent state on the next tick even if the event is delayed.
  setState({ mode: 'inline', win: null, mount: null });
}

// ─────────────────────────────────────────────────────────────────────────
// React surface.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Hook returning the current PiP render target. Re-renders whenever
 * openPipWindow / closePipWindow / pagehide flips the mode.
 */
export function usePipMode(): BureauPipMode {
  const [, setTick] = useState(0);
  useEffect(() => {
    return subscribeToPipMode(() => setTick((t) => t + 1));
  }, []);
  return state.mode;
}

/**
 * Hook returning the PiP mount node (or null when inline). The host
 * portal-renders <BureauDockedBox/> into this node when non-null.
 */
export function usePipMount(): HTMLElement | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    return subscribeToPipMode(() => setTick((t) => t + 1));
  }, []);
  return state.mount;
}

/**
 * Helper: portal `children` into the PiP window's mount node if we are
 * currently in pip mode. Returns null otherwise. Used by the docked-box
 * surface to mirror itself into the PiP window.
 *
 * Calling this from a component that lives inside <BureauProvider> means
 * the portal-rendered tree retains the same React context, so the mirrored
 * box reads exactly the same presence state as the inline one.
 */
export function PipPortal({ children }: { children: ReactNode }): React.ReactElement | null {
  const mount = usePipMount();
  if (!mount) return null;
  return createPortal(children, mount);
}

// ─────────────────────────────────────────────────────────────────────────
// PopoutBureauButton — the user-facing trigger.
// ─────────────────────────────────────────────────────────────────────────

const buttonBaseStyle: CSSProperties = {
  background: 'transparent',
  border: 'none',
  color: 'rgba(250, 250, 250, 0.65)',
  cursor: 'pointer',
  padding: 2,
  marginLeft: 4,
  borderRadius: 4,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  lineHeight: 0,
};

const buttonHoverStyle: CSSProperties = {
  ...buttonBaseStyle,
  color: '#fafafa',
  background: 'rgba(255,255,255,0.08)',
};

/**
 * Inline 14×14 "pop-out" glyph. Drawn as SVG so it scales with the box's
 * font-size and inherits color via currentColor.
 */
function PopoutIcon(): React.ReactElement {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* Outer window */}
      <rect x="2" y="4" width="9" height="9" rx="1.5" />
      {/* Pop-out arrow */}
      <path d="M9 3h4v4" />
      <path d="M13 3l-5 5" />
    </svg>
  );
}

export interface PopoutBureauButtonProps {
  /**
   * Override what happens on click. The default opens (or closes, if already
   * open) a Document PiP window with the default size.
   */
  onClick?: () => void;
  /** Optional extra style merged into the base button styles. */
  style?: CSSProperties;
  /** Optional tooltip override. */
  title?: string;
}

/**
 * Small icon button mounted by `<BureauDockedBox/>`. Renders only when the
 * browser supports Document Picture-in-Picture; on Firefox / Safari it is
 * `null`, so the docked-box header collapses gracefully.
 *
 * Clicking it toggles PiP mode: open if currently inline, close if currently
 * in pip. The button label / title reflects the current mode.
 */
export function PopoutBureauButton({
  onClick,
  style,
  title,
}: PopoutBureauButtonProps = {}): React.ReactElement | null {
  const mode = usePipMode();
  const [hover, setHover] = useState(false);

  // Detection has to run client-side; we keep the initial render stable for
  // any host that happens to SSR this tree (the host portal generally lives
  // in a browser-only mount, but be defensive).
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    setSupported(isDocumentPipSupported());
  }, []);

  if (!supported) return null;

  const isPip = mode === 'pip';
  const effectiveTitle =
    title ?? (isPip ? 'Return Bureau to the page' : 'Pop Bureau out into a separate window');

  const handleClick = (): void => {
    if (onClick) {
      onClick();
      return;
    }
    if (isPip) {
      closePipWindow();
    } else {
      // Fire-and-forget — we surface failures via console.warn inside the
      // helper, and the button reflects the actual mode via subscription.
      void openPipWindow();
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...(hover ? buttonHoverStyle : buttonBaseStyle),
        ...style,
      }}
      title={effectiveTitle}
      aria-label={effectiveTitle}
      aria-pressed={isPip}
      data-bureau-popout-button
    >
      <PopoutIcon />
    </button>
  );
}
