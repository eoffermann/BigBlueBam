// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

/**
 * Render-time sanitization of the Brief document body. The stored
 * html_snapshot and plain_text used to be injected into
 * dangerouslySetInnerHTML with no client-side sanitizer at all.
 */

const { docState, mutation } = vi.hoisted(() => ({
  docState: { current: null as Record<string, unknown> | null },
  mutation: () => ({ mutate: () => {}, isPending: false }),
}));

vi.mock('@/hooks/use-documents', () => ({
  useDocument: () => ({ data: docState.current, isLoading: false, refetch: () => {} }),
  useToggleStar: mutation,
  useArchiveDocument: mutation,
  useDuplicateDocument: mutation,
  usePromoteToBeacon: mutation,
  useRestoreDocument: mutation,
}));
vi.mock('@/hooks/use-collaboration', () => ({
  useCollaboration: () => ({ ydoc: {}, provider: null, isSynced: false }),
}));
vi.mock('@/components/editor/brief-editor', () => ({
  useCollaborativeEditor: () => null,
  BriefEditorContent: () => null,
}));
vi.mock('@bigbluebam/bureau-client', () => ({
  useBureauLocationLabel: () => {},
}));
vi.mock('@/hooks/use-comments', () => ({
  useComments: () => ({ data: [] }),
  useCreateComment: mutation,
  useResolveComment: mutation,
  useDeleteComment: mutation,
}));
vi.mock('@/hooks/use-versions', () => ({
  useVersions: () => ({ data: [] }),
  useRestoreVersion: mutation,
}));
vi.mock('@/hooks/use-projects', () => ({
  useProjectName: () => null,
}));
vi.mock('@/components/document/comment-thread', () => ({ CommentThread: () => null }));
vi.mock('@/components/document/export-menu', () => ({ ExportMenu: () => null }));
vi.mock('@/components/document/linked-items', () => ({ LinkedItems: () => null }));

import { DocumentDetailPage } from '../src/pages/document-detail';
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

const PAYLOAD = [
  '<p>hello</p>',
  '<img src=x onerror=alert(1)>',
  '<svg onload=alert(1)></svg>',
  '<a href="javascript:alert(1)">x</a>',
  '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
  '<script/src=//evil.example/x.js></script>',
].join('\n');

function makeDoc(overrides: Record<string, unknown>) {
  return {
    id: 'doc-1',
    slug: 'doc-1',
    title: 'Doc',
    status: 'draft',
    icon: null,
    summary: null,
    pinned: false,
    project_id: null,
    project_name: null,
    creator_name: 'Skipper',
    creator_avatar_url: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    published_at: null,
    word_count: 1,
    html_snapshot: null,
    plain_text: null,
    ...overrides,
  };
}

function bodyArticle(container: HTMLElement): HTMLElement {
  const article = container.querySelector('article.document-content');
  if (!article) throw new Error('document body <article> not rendered');
  return article as HTMLElement;
}

afterEach(() => {
  cleanup();
  docState.current = null;
});

describe('Brief DocumentDetailPage body sanitization', () => {
  it('sanitizes a stored html_snapshot before rendering it', () => {
    docState.current = makeDoc({ html_snapshot: PAYLOAD });
    const { container } = render(<DocumentDetailPage idOrSlug="doc-1" onNavigate={() => {}} />);
    const article = bodyArticle(container);
    expect(executableFeatures(article)).toEqual([]);
    expect(article.querySelector('p')?.textContent).toBe('hello');
  });

  it('sanitizes the plain_text (markdown) branch before rendering it', () => {
    docState.current = makeDoc({ plain_text: `**bold**\n${PAYLOAD}` });
    const { container } = render(<DocumentDetailPage idOrSlug="doc-1" onNavigate={() => {}} />);
    const article = bodyArticle(container);
    expect(executableFeatures(article)).toEqual([]);
    expect(article.querySelector('strong')?.textContent).toBe('bold');
  });
});

describe('Brief sanitizeHtml', () => {
  it('strips executable vectors', () => {
    expect(executableFeatures(parse(sanitizeHtml(PAYLOAD)))).toEqual([]);
  });

  it('keeps Tiptap/markdown formatting, task lists, links, and code', () => {
    const md = [
      '# Title',
      '**bold** and *italic* and `inline`',
      '[docs](https://example.com/help)',
      '- [x] done item',
      '```js',
      'const x = 1;',
      '```',
    ].join('\n');
    const root = parse(sanitizeHtml(markdownToHtml(md)));
    expect(root.querySelector('h1')?.textContent).toBe('Title');
    expect(root.querySelector('strong')?.textContent).toBe('bold');
    expect(root.querySelector('em')?.textContent).toBe('italic');
    expect(Array.from(root.querySelectorAll('code')).map((c) => c.textContent)).toContain('inline');
    expect(root.querySelector('pre code.language-js')?.textContent).toBe('const x = 1;');
    expect(root.querySelector('a')?.getAttribute('href')).toBe('https://example.com/help');
    const task = root.querySelector('li[data-type="taskItem"]');
    expect(task?.getAttribute('data-checked')).toBe('true');
    expect(task?.querySelector('input[type="checkbox"]')).not.toBeNull();
  });

  it('keeps target on Tiptap link output', () => {
    const html = '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer nofollow">x</a></p>';
    const a = parse(sanitizeHtml(html)).querySelector('a');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer nofollow');
  });
});
