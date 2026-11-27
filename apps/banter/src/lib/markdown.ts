// Banter renders with the shared converter and sanitizer (@bigbluebam/ui/markdown, #331); this
// module only turns on Banter's @mention highlighting and Bam task-reference links.
import { markdownToHtml as sharedMarkdownToHtml, type MarkdownOptions } from '@bigbluebam/ui/markdown';

export { sanitizeHtml } from '@bigbluebam/ui/markdown';

export const BANTER_MARKDOWN_OPTIONS: MarkdownOptions = { mentions: true, taskRefs: true };

/** Output is NOT safe on its own; always render sanitizeHtml(markdownToHtml(md)). */
export function markdownToHtml(md: string): string {
  return sharedMarkdownToHtml(md, BANTER_MARKDOWN_OPTIONS);
}
