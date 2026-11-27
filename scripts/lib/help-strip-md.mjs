/**
 * Strip inline Markdown from one help.md line, producing plain text for the
 * Help Center search index (scripts/help/build-help-index.mjs).
 *
 * Inline code spans are kept verbatim (only the backticks go): a code span is
 * literal text, so `/bay/r#<token>`, `a -> b` and `bond_get_*` must reach the
 * index exactly as written. Outside code spans we drop emphasis markers and
 * only the Markdown-structural `#` / `>` at the start of the line (heading and
 * blockquote markers); a `#` or `>` in the middle of prose is content.
 */
export function stripMd(s) {
  const noImages = s.replace(/!\[[^\]]*\]\([^)]*\)/g, '');
  const noLinks = noImages.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  const lead = noLinks.replace(/^\s*(?:(?:#{1,6}|>)\s*)+/, '');

  // Split on inline code spans (one or more backticks, matched by length).
  const parts = [];
  const codeRe = /(`+)([\s\S]*?[^`])\1(?!`)/g;
  let last = 0;
  let m;
  while ((m = codeRe.exec(lead)) !== null) {
    parts.push({ code: false, text: lead.slice(last, m.index) });
    parts.push({ code: true, text: m[2].trim() });
    last = m.index + m[0].length;
  }
  parts.push({ code: false, text: lead.slice(last) });

  return parts
    .map((p) => {
      if (p.code) return p.text;
      return p.text
        .replace(/`/g, '') // stray unmatched backticks
        .replace(/\*/g, '') // bold / italic asterisks
        .replace(/(^|[^\w])_+|_+(?=[^\w]|$)/g, '$1'); // _emphasis_, not snake_case
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}
