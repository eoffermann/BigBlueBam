/**
 * Location-context labels — the "what is the user actually looking at"
 * provider for the docked box.
 *
 * Host adapters' describeLocation() only knows the URL, so historically
 * every app reported `label: path` and the widget could at best render a
 * de-UUID'd breadcrumb ("Projects › Board"). The PAGES, however, already
 * hold the real names — the project query on the Bam board knows "Frndo",
 * the diagram query in Blueprint knows "Org Chart". This module is the
 * channel that carries those names to the widget (and onward to the
 * presence session, so Hunt and people-here read well too):
 *
 *   - `useBureauLocationLabel(name)` — one-liner for pages: announces the
 *     entity name for the CURRENT path while mounted.
 *   - a `bureau:location-label` CustomEvent bridge — for code that must
 *     not depend on bureau-client (PresenceChipStrip in @bigbluebam/ui
 *     dispatches its surfaceLabel, which instantly covers every page that
 *     renders presence chips).
 *
 * Entries are token-stacked per path: a task drawer's label can shadow
 * the board page's label and the board's reappears when the drawer
 * closes. Labels only apply while the browser is actually ON the path
 * they were announced for — a stale label from a previous page never
 * leaks onto the next one.
 */

import { useEffect, useRef } from 'react';

interface LabelEntry {
  token: symbol | string;
  path: string;
  label: string;
}

let entries: LabelEntry[] = [];
const subscribers = new Set<() => void>();

function notify(): void {
  for (const fn of subscribers) fn();
}

export function normalizeLabelPath(url: string): string {
  try {
    return new URL(url, typeof window !== 'undefined' ? window.location.href : 'http://x/')
      .pathname;
  } catch {
    return url;
  }
}

/**
 * Sets (or clears, with null) the label owned by `token` for a path.
 * Later announcements shadow earlier ones on the same path.
 */
export function setLocationLabelForToken(
  token: symbol | string,
  label: string | null | undefined,
  forUrl?: string,
): void {
  const path = normalizeLabelPath(
    forUrl ?? (typeof window !== 'undefined' ? window.location.pathname : ''),
  );
  const trimmed = label?.trim();
  const before = entries;
  entries = entries.filter((e) => e.token !== token);
  if (trimmed) {
    entries = [...entries, { token, path, label: trimmed }];
  }
  const changed =
    before.length !== entries.length ||
    before.some((e, i) => entries[i] !== e);
  if (changed) notify();
}

/** Newest announced label for a URL's path, or null. */
export function resolveLocationLabel(url: string): string | null {
  const path = normalizeLabelPath(url);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.path === path) return entries[i]!.label;
  }
  return null;
}

export function subscribeLocationLabels(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

/**
 * Page hook: announce the human name of what this page shows ("Frndo
 * Board", "Org Chart"). Pass null/undefined while the entity is still
 * loading; the announcement updates when the name arrives and clears on
 * unmount.
 */
export function useBureauLocationLabel(label: string | null | undefined): void {
  const tokenRef = useRef<symbol | null>(null);
  if (tokenRef.current === null) tokenRef.current = Symbol('bureau-location-label');
  useEffect(() => {
    const token = tokenRef.current!;
    setLocationLabelForToken(token, label ?? null);
    return () => setLocationLabelForToken(token, null);
  }, [label]);
}

/** CustomEvent name — detail: { label: string | null, url?: string }. */
export const LOCATION_LABEL_EVENT = 'bureau:location-label';

const EVENT_TOKEN = 'bureau:location-label-event';

/**
 * Listens for LOCATION_LABEL_EVENT so dependency-free packages (the
 * presence chip strip) can announce labels. Installed once by the
 * provider; returns the uninstaller.
 */
export function installLocationLabelEventBridge(): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as
      | { label?: unknown; url?: unknown }
      | undefined;
    if (!detail) return;
    setLocationLabelForToken(
      EVENT_TOKEN,
      typeof detail.label === 'string' ? detail.label : null,
      typeof detail.url === 'string' ? detail.url : undefined,
    );
  };
  window.addEventListener(LOCATION_LABEL_EVENT, handler);
  return () => window.removeEventListener(LOCATION_LABEL_EVENT, handler);
}

/** Test helper. */
export function _resetLocationLabelsForTests(): void {
  entries = [];
}
