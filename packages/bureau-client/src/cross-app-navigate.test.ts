// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { crossAppNavigate, firstPathSegment } from './cross-app-navigate.js';

// Pins the SPA-boundary contract behind the "invite updates the URL bar
// but the page never loads" bug: pushState adapters can only route
// within their own SPA, so cross-app targets MUST become full document
// loads while same-app targets keep the soft navigation.

// jsdom default location is http://localhost/ — set a path for segment
// comparison via history (jsdom allows pushState).
beforeEach(() => {
  window.history.pushState(null, '', '/banter/channels/general');
});

describe('firstPathSegment', () => {
  it('extracts the app mount', () => {
    expect(firstPathSegment('/b3/projects/abc')).toBe('b3');
    expect(firstPathSegment('/banter/')).toBe('banter');
    expect(firstPathSegment('/')).toBe('');
  });
});

describe('crossAppNavigate', () => {
  it('cross-app target → full document load, host adapter NOT called', () => {
    const host = vi.fn();
    const assign = vi.fn();
    crossAppNavigate(host, '/b3/projects/abc/board', assign);
    expect(assign).toHaveBeenCalledWith('/b3/projects/abc/board');
    expect(host).not.toHaveBeenCalled();
  });

  it('same-app target → host adapter (soft navigation), no reload', () => {
    const host = vi.fn();
    const assign = vi.fn();
    crossAppNavigate(host, '/banter/channels/random', assign);
    expect(host).toHaveBeenCalledWith('/banter/channels/random');
    expect(assign).not.toHaveBeenCalled();
  });

  it('absolute same-origin cross-app URL → stripped and hard-loaded', () => {
    const host = vi.fn();
    const assign = vi.fn();
    crossAppNavigate(host, `${window.location.origin}/beacon/some-article?x=1#y`, assign);
    expect(assign).toHaveBeenCalledWith('/beacon/some-article?x=1#y');
    expect(host).not.toHaveBeenCalled();
  });

  it('cross-origin URL → full URL load', () => {
    const host = vi.fn();
    const assign = vi.fn();
    crossAppNavigate(host, 'https://elsewhere.example/path', assign);
    expect(assign).toHaveBeenCalledWith('https://elsewhere.example/path');
    expect(host).not.toHaveBeenCalled();
  });

  it('same-app relative path with query/hash stays soft', () => {
    const host = vi.fn();
    const assign = vi.fn();
    crossAppNavigate(host, '/banter/dm/123?focus=1', assign);
    expect(host).toHaveBeenCalledWith('/banter/dm/123?focus=1');
  });
});
