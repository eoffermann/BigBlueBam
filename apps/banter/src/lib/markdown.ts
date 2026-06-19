/**
 * Simple markdown-to-HTML converter.
 * Handles: **bold**, *italic*, `inline code`, ```code blocks```,
 * [links](url), ![images](url), ## headings, - lists, newlines.
 * Also sanitizes output by stripping script tags and event handlers.
 */
export function markdownToHtml(md: string): string {
  if (!md) return '';

  let html = md;

  // Escape HTML entities first (prevents XSS)
  html = html
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks (``` ... ```) — must come before inline transformations
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

  // Italic: *text*
  html = html.replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>');

  // @mentions — match the handle charset the composer inserts (slugified
  // display_name: lower-case + digits + '-', plus '.'/'_' for dotted/email
  // localpart handles), so a multi-word handle like @jonas-grumby highlights
  // whole rather than stopping at the first hyphen.
  html = html.replace(/@([a-zA-Z0-9_.-]+)/g, '<span class="mention-highlight">@$1</span>');

  // Bam task references: PREFIX-123 → clickable link that resolves to
  // the task's project board via /b3/tasks/ref/<REF>. Works with ANY
  // project prefix (MAGE-38, FRND-7, etc.) — matches the tasks.human_id
  // column format. Case-sensitive (prefixes are stored uppercase).
  html = html.replace(
    /\b([A-Z]{2,10})-(\d+)\b/g,
    (_m, prefix: string, num: string) => {
      const ref = `${prefix}-${num}`;
      return `<a href="/b3/tasks/ref/${ref}" class="rich-text-link task-reference" title="View task ${ref}">${ref}</a>`;
    },
  );

  // Process line-by-line for headings and lists
  const lines = html.split('\n');
  const processed: string[] = [];
  let inList = false;

  for (const line of lines) {
    // Headings: ## text
    if (/^#{1,6}\s/.test(line)) {
      if (inList) {
        processed.push('</ul>');
        inList = false;
      }
      const level = line.match(/^(#+)/)?.[1]?.length ?? 2;
      const text = line.replace(/^#+\s*/, '');
      processed.push(`<h${level} class="rich-text-heading">${text}</h${level}>`);
      continue;
    }

    // Unordered list: - item
    if (/^\s*[-*]\s/.test(line)) {
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

    // Empty line = paragraph break
    if (line.trim() === '') {
      processed.push('<br />');
    } else {
      processed.push(line);
    }
  }

  if (inList) {
    processed.push('</ul>');
  }

  html = processed.join('\n');

  // Convert remaining single newlines to <br>
  html = html.replace(/(?<!<\/(?:pre|ul|li|h[1-6]|br\s?\/)>)\n(?!<(?:pre|ul|li|h[1-6]|br))/g, '<br />');

  return html;
}

/**
 * Sanitize HTML string — strip dangerous tags/attributes.
 */
export function sanitizeHtml(html: string): string {
  let clean = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  clean = clean.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
  clean = clean.replace(/href\s*=\s*["']javascript:[^"']*["']/gi, 'href="#"');
  return clean;
}
