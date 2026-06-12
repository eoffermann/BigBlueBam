// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LOCATION_LABEL_EVENT,
  _resetLocationLabelsForTests,
  installLocationLabelEventBridge,
  normalizeLabelPath,
  resolveLocationLabel,
  setLocationLabelForToken,
  subscribeLocationLabels,
} from './location-context.js';

// Pins the location-context contract: pages announce real entity names
// ("Frndo Board", "Org Chart"); the newest announcement for the CURRENT
// path wins; labels never leak across paths; the chip-strip CustomEvent
// bridge feeds the same store.

afterEach(() => {
  _resetLocationLabelsForTests();
});

describe('setLocationLabelForToken / resolveLocationLabel', () => {
  it('returns the announced label for its path only', () => {
    setLocationLabelForToken('a', 'Frndo Board', '/b3/projects/x/board');
    expect(resolveLocationLabel('/b3/projects/x/board')).toBe('Frndo Board');
    expect(resolveLocationLabel('/b3/projects/OTHER/board')).toBeNull();
  });

  it('newest announcement shadows older ones on the same path, and clearing restores', () => {
    setLocationLabelForToken('board-page', 'Frndo Board', '/b3/p/board');
    setLocationLabelForToken('task-drawer', 'Fix login bug', '/b3/p/board');
    expect(resolveLocationLabel('/b3/p/board')).toBe('Fix login bug');

    // Drawer closes → its token clears → the page's label resurfaces.
    setLocationLabelForToken('task-drawer', null, '/b3/p/board');
    expect(resolveLocationLabel('/b3/p/board')).toBe('Frndo Board');
  });

  it('normalizes absolute URLs to paths for matching', () => {
    setLocationLabelForToken('t', 'Org Chart', 'https://example.com/blueprint/d/abc');
    expect(resolveLocationLabel('/blueprint/d/abc')).toBe('Org Chart');
    expect(normalizeLabelPath('https://example.com/blueprint/d/abc?x=1')).toBe(
      '/blueprint/d/abc',
    );
  });

  it('notifies subscribers on change and not on no-op re-sets', () => {
    const spy = vi.fn();
    const off = subscribeLocationLabels(spy);
    setLocationLabelForToken('t', 'A', '/p');
    expect(spy).toHaveBeenCalledTimes(1);
    // Clearing a token that holds nothing is a no-op.
    setLocationLabelForToken('other-token', null, '/p');
    expect(spy).toHaveBeenCalledTimes(1);
    off();
  });
});

describe('event bridge', () => {
  it('applies labels dispatched via the bureau:location-label CustomEvent', () => {
    const uninstall = installLocationLabelEventBridge();
    window.dispatchEvent(
      new CustomEvent(LOCATION_LABEL_EVENT, {
        detail: { label: 'Org Chart', url: '/blueprint/d/abc' },
      }),
    );
    expect(resolveLocationLabel('/blueprint/d/abc')).toBe('Org Chart');

    window.dispatchEvent(
      new CustomEvent(LOCATION_LABEL_EVENT, {
        detail: { label: null, url: '/blueprint/d/abc' },
      }),
    );
    expect(resolveLocationLabel('/blueprint/d/abc')).toBeNull();
    uninstall();
  });
});
