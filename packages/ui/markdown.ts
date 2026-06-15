/**
 * Canonical markdown-to-HTML converter for all BigBlueBam apps.
 *
 * Every frontend app imports this file via a Vite alias:
 *   '@bigbluebam/ui/markdown' -> '<root>/packages/ui/markdown.ts'
 *
 * Handles: **bold**, *italic*, `inline code`, ```code blocks```,
 * [links](url), ![images](url), ## headings, - lists, newlines.
 * Sanitizes output by stripping script tags and event handlers.
 */

import DOMPurify from 'dompurify';

export function markdownToHtml(md: string): string {
  if (!md) return '';

  let html = md;

  // Escape HTML entities first (prevents XSS)
  html = html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

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

/**
 * Sanitize HTML string using DOMPurify for robust, spec-compliant sanitization.
 */
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html);
}
