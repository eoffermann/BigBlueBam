/**
 * Bastion publishes its Bolt events through an outbox (Bastion spec 8.1): the call site is
 * `enqueueBastionEvent('<event>', payload, tx, opts)` and the drainer's own publish is dynamic.
 * So the catalog guard treats every `enqueueBastionEvent(` call as a `bastion` publisher:
 *
 *   - the first argument must be a plain string literal (a dynamic name would evade the guard);
 *   - the pair (bastion, <event>) must be declared in event-catalog.ts.
 *
 * The function's own declaration (`function enqueueBastionEvent(`) is not a call.
 */

const NEEDLE = 'enqueueBastionEvent';

/** The first argument as a literal string, or null when it is not one. */
function firstLiteralArg(text, openParen) {
  let i = openParen + 1;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  const q = text[i];
  if (q !== "'" && q !== '"' && q !== '`') return null;
  let j = i + 1;
  let value = '';
  for (; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') {
      value += text[j + 1] ?? '';
      j += 1;
      continue;
    }
    if (c === q) break;
    if (q === '`' && c === '$' && text[j + 1] === '{') return null; // interpolated template
    value += c;
  }
  if (j >= text.length) return null;
  let k = j + 1;
  while (k < text.length && /\s/.test(text[k])) k += 1;
  // The literal must be the whole first argument, not the start of an expression.
  if (text[k] !== ',' && text[k] !== ')') return null;
  return value;
}

/**
 * @param {string} file
 * @param {string} text
 * @param {{ pairs: Set<string> }} catalog
 * @returns {Array<{ file: string, eventName: string, source: string, reason: string }>}
 */
export function checkBastionEnqueues(file, text, catalog) {
  const out = [];
  let idx = 0;
  while ((idx = text.indexOf(NEEDLE, idx)) !== -1) {
    const start = idx;
    idx += NEEDLE.length;
    const before = start === 0 ? ' ' : text[start - 1];
    if (/[A-Za-z0-9_$]/.test(before)) continue;
    if (/function\s*\*?\s*$/.test(text.slice(Math.max(0, start - 16), start))) continue;
    let after = idx;
    while (after < text.length && /\s/.test(text[after])) after += 1;
    if (text[after] !== '(') continue;
    const name = firstLiteralArg(text, after);
    if (name === null) {
      out.push({ file, eventName: '<dynamic>', source: 'bastion', reason: 'enqueueBastionEvent must be called with a string-literal event name' });
      continue;
    }
    if (!catalog.pairs.has(`bastion:${name}`)) {
      out.push({ file, eventName: name, source: 'bastion', reason: `(source="bastion", event_type="${name}") not found in event-catalog.ts` });
    }
  }
  return out;
}
