import { describe, it, expect } from 'vitest';
import { markdownToHtml, sanitizeHtml } from '../src/lib/markdown';
import * as shared from '@bigbluebam/ui/markdown';

// #331: Bam's SPA used a private markdown copy whose sanitizer was DOMPurify's default, which
// strips `target`, so markdown links opened in place instead of a new tab. Every SPA now renders
// through @bigbluebam/ui/markdown with one config: target survives only as _blank, always with
// rel="noopener noreferrer".

function parse(html: string) {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content;
}

describe('frontend markdown uses the shared module', () => {
  it('is the shared implementation, not a copy', () => {
    expect(markdownToHtml).toBe(shared.markdownToHtml);
    expect(sanitizeHtml).toBe(shared.sanitizeHtml);
  });

  it('keeps target=_blank with rel=noopener noreferrer on markdown links', () => {
    const link = parse(sanitizeHtml(markdownToHtml('[docs](https://example.com/help)'))).querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/help');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('adds rel to a raw target=_blank link and drops any other target', () => {
    const root = parse(
      sanitizeHtml('<a id="a" href="https://x.example" target="_blank">a</a><a id="b" href="/y" target="_top">b</a>'),
    );
    expect(root.querySelector('#a')?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(root.querySelector('#b')?.hasAttribute('target')).toBe(false);
  });

  it('still removes executable markup', () => {
    const root = parse(sanitizeHtml('<img src=x onerror=alert(1)><a href="javascript:alert(1)">x</a><script>1</script>'));
    expect(root.querySelector('img')?.hasAttribute('onerror')).toBe(false);
    expect(root.querySelector('a')?.getAttribute('href') ?? '').not.toMatch(/javascript:/i);
    expect(root.querySelector('script')).toBeNull();
  });
});
