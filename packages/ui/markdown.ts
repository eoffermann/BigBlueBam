/**
 * The one markdown-to-HTML converter and the one HTML sanitizer for every
 * BigBlueBam SPA (#331).
 *
 * Apps import it as '@bigbluebam/ui/markdown' (a Vite alias in each app's
 * vite.config.ts, and the package export in packages/ui/package.json). The
 * per-app `src/lib/markdown.ts` files are thin re-exports that only pick
 * options (Banter turns on mentions and task refs). Brief keeps its own
 * Tiptap loader (markdown into editor nodes, plus Turndown for the way back)
 * because that is an editor format, not a renderer, but it sanitizes with
 * sanitizeHtml from here. No SPA imports DOMPurify directly; a change to the
 * sanitizer is made once, here, and reaches every app.
 *
 * markdownToHtml handles **bold**, *italic*, `inline code`, ```code
 * blocks```, [links](url), ![images](url), # headings (with anchor ids),
 * > blockquotes, - lists and newlines. Its output is NOT safe on its own
 * (link URLs are not escaped): always render sanitizeHtml(markdownToHtml(md)).
 */

import DOMPurify from 'dompurify';

export interface MarkdownOptions {
  /** Highlight @handle mentions (Banter). */
  mentions?: boolean;
  /** Link Bam task references like MAGE-38 to /b3/tasks/ref/MAGE-38 (Banter). */
  taskRefs?: boolean;
}

export function markdownToHtml(md: string, options: MarkdownOptions = {}): string {
  if (!md) return '';

  let html = md;

  // Escape HTML entities first (prevents raw HTML in the source from rendering)
  html = html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Code blocks (``` ... ```) - must come before inline transformations
  html = html.replace(/```([\s\S]*?)```/g, (_match, code: string) => {
    return `<pre class="rich-text-code-block"><code>${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`\n]+)`/g, '<code class="rich-text-inline-code">$1</code>');

  // Images: ![alt](url)
  html = html.replace(
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer"><img src="$2" alt="$1" class="rich-text-image" /></a>',
  );

  // Links: [text](url)
  html = html.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="rich-text-link">$1</a>',
  );

  // Bold: **text**
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

  // Italic: *text* (but not inside words with **)
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

  if (options.mentions) {
    // Match the handle charset the composer inserts (slugified display_name:
    // lower-case + digits + '-', plus '.'/'_' for dotted/email localpart
    // handles), so a multi-word handle like @jonas-grumby highlights whole.
    html = html.replace(/@([a-zA-Z0-9_.-]+)/g, '<span class="mention-highlight">@$1</span>');
  }

  if (options.taskRefs) {
    // PREFIX-123 -> link that resolves to the task's project board. Any
    // project prefix (MAGE-38, FRND-7); case-sensitive like tasks.human_id.
    html = html.replace(/\b([A-Z]{2,10})-(\d+)\b/g, (_m, prefix: string, num: string) => {
      const ref = `${prefix}-${num}`;
      return `<a href="/b3/tasks/ref/${ref}" class="rich-text-link task-reference" title="View task ${ref}">${ref}</a>`;
    });
  }

  // Process line-by-line for headings, blockquotes, and lists
  const lines = html.split('\n');
  const processed: string[] = [];
  let inList = false;
  let inQuote = false;
  // The HTML-escape pass above turned a leading markdown `>` into `&gt;`, so we
  // match that here. Consecutive quote lines fold into one <blockquote>.
  const closeQuote = () => {
    if (inQuote) {
      processed.push('</blockquote>');
      inQuote = false;
    }
  };

  for (const line of lines) {
    // Blockquote: `> text` (escaped to `&gt; text`)
    if (/^\s*&gt;\s?/.test(line)) {
      if (inList) {
        processed.push('</ul>');
        inList = false;
      }
      if (!inQuote) {
        processed.push('<blockquote class="rich-text-blockquote">');
        inQuote = true;
      }
      processed.push(line.replace(/^\s*&gt;\s?/, ''));
      continue;
    }

    // Headings: ## text - generate id for anchor linking
    if (/^#{1,6}\s/.test(line)) {
      closeQuote();
      if (inList) {
        processed.push('</ul>');
        inList = false;
      }
      const level = line.match(/^(#+)/)?.[1]?.length ?? 2;
      const text = line.replace(/^#+\s*/, '');
      const id = text
        .toLowerCase()
        .replace(/<[^>]+>/g, '')
        .replace(/[^\w\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '');
      processed.push(`<h${level} id="${id}" class="rich-text-heading">${text}</h${level}>`);
      continue;
    }

    // Unordered list: - item
    if (/^\s*[-*]\s/.test(line)) {
      closeQuote();
      if (!inList) {
        processed.push('<ul class="rich-text-list">');
        inList = true;
      }
      const text = line.replace(/^\s*[-*]\s/, '');
      processed.push(`<li>${text}</li>`);
      continue;
    }

    // Close list if we hit a non-list line
    if (inList) {
      processed.push('</ul>');
      inList = false;
    }

    // Empty line = paragraph break (also ends a blockquote)
    if (line.trim() === '') {
      closeQuote();
      processed.push('<br />');
    } else {
      closeQuote();
      processed.push(line);
    }
  }

  if (inList) {
    processed.push('</ul>');
  }
  closeQuote();

  html = processed.join('\n');

  // Convert remaining single newlines to <br> (except after block elements)
  html = html.replace(
    /(?<!<\/(?:pre|ul|li|h[1-6]|blockquote|br\s?\/)>)(?<!<blockquote class="rich-text-blockquote">)\n(?!<(?:pre|ul|li|h[1-6]|blockquote|\/blockquote|br))/g,
    '<br />',
  );

  return html;
}

// ----- Sanitizer -----

/**
 * The single sanitizer config. DOMPurify's allowlist removes every executable
 * feature (on* handlers, javascript: URLs, <script>, <iframe srcdoc>, ...).
 * `target` is added so markdown and Tiptap links keep opening in a new tab.
 */
export const SANITIZE_CONFIG = { ADD_ATTR: ['target'] };

type Purifier = typeof DOMPurify;
let purifier: Purifier | null = null;

/**
 * A dedicated DOMPurify instance, so the hook below never leaks into another
 * caller of the global instance. The hook keeps `target` safe: only
 * `_blank` survives, and its rel always includes noopener and noreferrer
 * (other tokens such as nofollow are kept) so the opened page cannot reach
 * window.opener.
 */
function getPurifier(): Purifier {
  if (purifier) return purifier;
  const instance: Purifier = typeof window !== 'undefined' ? DOMPurify(window) : DOMPurify;
  instance.addHook('afterSanitizeAttributes', (node) => {
    const el = node as Element;
    if (typeof el.hasAttribute !== 'function' || !el.hasAttribute('target')) return;
    if (el.getAttribute('target') === '_blank') {
      // Keep any other rel tokens (Tiptap adds nofollow); guarantee these two.
      const rel = new Set((el.getAttribute('rel') ?? '').split(/\s+/).filter(Boolean));
      rel.add('noopener');
      rel.add('noreferrer');
      el.setAttribute('rel', [...rel].join(' '));
    } else {
      el.removeAttribute('target');
    }
  });
  purifier = instance;
  return instance;
}

/** Sanitize an HTML string for dangerouslySetInnerHTML. */
export function sanitizeHtml(html: string): string {
  return getPurifier().sanitize(html, SANITIZE_CONFIG) as string;
}
