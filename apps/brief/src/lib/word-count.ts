/**
 * Count the words in an HTML fragment (the Brief editor's live word counter).
 *
 * Parses with DOMParser into a separate, inert document (#324). Assigning the
 * HTML to innerHTML of an element created in the live document would run
 * event handlers such as <img onerror> even though the element is never
 * attached; DOMParser's document has no browsing context, so nothing in it
 * executes or loads.
 */
export function countWordsInHtml(html: string): number {
  if (!html) return 0;
  const text = new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '';
  return text
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
}
