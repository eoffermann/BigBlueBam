// Brief's Tiptap bridge: markdownToHtml loads markdown into editor nodes (task lists, tables,
// highlights) and htmlToMarkdown (Turndown) saves it back. The HTML sanitizer is the shared one
// from @bigbluebam/ui/markdown (#331); never import DOMPurify here.
import TurndownService from 'turndown';

// ----- HTML to Markdown (for saving to backend) -----

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  hr: '---',
  emDelimiter: '*',
  strongDelimiter: '**',
});

// Task list items
turndown.addRule('taskItem', {
  filter: (node) =>
    node.nodeName === 'LI' && node.getAttribute('data-type') === 'taskItem',
  replacement: (content, node) => {
    const checked = (node as Element).getAttribute('data-checked') === 'true';
    return `${checked ? '- [x]' : '- [ ]'} ${content.trim()}\n`;
  },
});

// Task list wrapper — skip the <ul> wrapper to let items handle themselves
turndown.addRule('taskList', {
  filter: (node) =>
    node.nodeName === 'UL' && node.getAttribute('data-type') === 'taskList',
  replacement: (content) => `\n${content}\n`,
});

// Table support
turndown.addRule('tableCell', {
  filter: ['td', 'th'],
  replacement: (content) => ` ${content.trim()} |`,
});

turndown.addRule('tableRow', {
  filter: 'tr',
  replacement: (content) => `|${content}\n`,
});

turndown.addRule('tableHead', {
  filter: 'thead',
  replacement: (content) => {
    // Count cells to build separator row
    const cols = (content.match(/\|/g) || []).length - 1;
    const separator = `|${' --- |'.repeat(cols)}\n`;
    return `${content}${separator}`;
  },
});

turndown.addRule('tableBody', {
  filter: 'tbody',
  replacement: (content) => content,
});

turndown.addRule('table', {
  filter: 'table',
  replacement: (content) => `\n${content}\n`,
});

// Highlight / mark
turndown.addRule('highlight', {
  filter: 'mark',
  replacement: (content) => `==${content}==`,
});

// Underline — there's no standard Markdown for underline, use HTML
turndown.addRule('underline', {
  filter: 'u',
  replacement: (content) => `<u>${content}</u>`,
});

export function htmlToMarkdown(html: string): string {
  if (!html || html === '<p></p>') return '';
  return turndown.turndown(html);
}

// ----- Markdown to HTML (for loading into Tiptap) -----

export function markdownToHtml(markdown: string): string {
  if (!markdown) return '';

  let html = markdown;

  // Escape HTML entities first (except for existing HTML tags like <u>)
  // We'll handle this carefully to not break intentional HTML

  // Code blocks (fenced) — process first to avoid interfering with inline patterns
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const langAttr = lang ? ` class="language-${lang}"` : '';
    return `<pre><code${langAttr}>${escapeHtml(code.trimEnd())}</code></pre>`;
  });

  // Split by code blocks to avoid processing inside them
  const parts = html.split(/(<pre><code[\s\S]*?<\/code><\/pre>)/g);

  html = parts
    .map((part, i) => {
      // Skip code blocks (odd indices after split)
      if (i % 2 === 1) return part;
      return convertInlineMd(part);
    })
    .join('');

  return html;
}

function convertInlineMd(text: string): string {
  let html = text;

  // Headings (must be at start of line)
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Horizontal rules
  html = html.replace(/^---$/gm, '<hr>');
  html = html.replace(/^\*\*\*$/gm, '<hr>');

  // Blockquotes
  html = html.replace(/^> (.+)$/gm, '<blockquote><p>$1</p></blockquote>');

  // Task lists
  html = html.replace(
    /^- \[x\] (.+)$/gm,
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="true"><label><input type="checkbox" checked></label><div>$1</div></li></ul>',
  );
  html = html.replace(
    /^- \[ \] (.+)$/gm,
    '<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><label><input type="checkbox"></label><div>$1</div></li></ul>',
  );

  // Unordered lists
  html = html.replace(/^- (.+)$/gm, '<ul><li>$1</li></ul>');
  html = html.replace(/^\* (.+)$/gm, '<ul><li>$1</li></ul>');

  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<ol><li>$1</li></ol>');

  // Merge adjacent list elements
  html = html.replace(/<\/ul>\n<ul>/g, '\n');
  html = html.replace(/<\/ul>\n<ul data-type="taskList">/g, '\n');
  html = html.replace(/<\/ol>\n<ol>/g, '\n');

  // Images
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1">');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Highlight ==text==
  html = html.replace(/==([^=]+)==/g, '<mark>$1</mark>');

  // Bold + italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');

  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Strikethrough
  html = html.replace(/~~(.+?)~~/g, '<s>$1</s>');

  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Paragraphs: wrap remaining bare lines
  html = html.replace(/^(?!<[a-z/])(.*\S.*)$/gm, '<p>$1</p>');

  // Clean up double newlines into proper spacing
  html = html.replace(/\n{2,}/g, '\n');

  return html;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ----- Render-time sanitization -----

// The converter above is a Tiptap loader (markdown into editor nodes), not a renderer, so it stays
// here. Rendering document-detail.tsx's html_snapshot / markdownToHtml output goes through the
// suite's one sanitizer (@bigbluebam/ui/markdown, #331): write-time sanitization in brief-api is
// the primary defense, but it cannot cover rows written before it existed or by another service.
export { sanitizeHtml } from '@bigbluebam/ui/markdown';
