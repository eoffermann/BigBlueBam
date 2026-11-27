// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { countWordsInHtml } from '@/lib/word-count';

// #324: the word counter used to assign editor HTML to innerHTML of a div
// created in the live document, where handlers like <img onerror> run even
// though the element is never attached. It must parse into an inert document.

describe('countWordsInHtml', () => {
  afterEach(() => vi.restoreAllMocks());

  it('counts words across elements', () => {
    expect(countWordsInHtml('<p>Daily <strong>Coconut</strong> Count</p>\n<p>for the Skipper</p>')).toBe(6);
    expect(countWordsInHtml('')).toBe(0);
    expect(countWordsInHtml('<p>   </p>')).toBe(0);
  });

  it('never creates elements in, or assigns HTML into, the live document', () => {
    const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'innerHTML')!;
    const innerHtmlSet = vi.fn(function (this: Element, v: string) {
      desc.set!.call(this, v);
    });
    Object.defineProperty(Element.prototype, 'innerHTML', { ...desc, set: innerHtmlSet });
    const createSpy = vi.spyOn(document, 'createElement');
    try {
      const n = countWordsInHtml('<p>hi there</p><img src="x" onerror="window.__pwned = 1">');
      expect(n).toBe(2);
      expect(innerHtmlSet).not.toHaveBeenCalled();
      expect(createSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(Element.prototype, 'innerHTML', desc);
    }
  });
});
