/**
 * Payload-key drift guard for the Bolt event catalog (issue #262).
 *
 * The catalog guard (scripts/check-bolt-catalog.mjs) already checks that every published
 * (source, event_type) pair is declared. This module checks the PAYLOAD too: the Bolt rule builder
 * and the MCP Bolt tools offer condition fields and template variables from each event's
 * `payload_schema`, so a key the publisher sends but the catalog does not declare is invisible to
 * rule authors, and a rule written against a declared name that is never sent never matches.
 *
 * Checked: every publish call whose payload argument is an OBJECT LITERAL,
 *   publishBoltEvent('<event>', '<source>', { ... }, orgId, ...)        (third argument)
 *   publishBoltEventChecked('<event>', '<source>', { ... }, ...)         (third argument)
 *   enqueueBastionEvent('<event>', { ... }, tx, opts)                    (second argument, source bastion)
 * Each explicit top-level key must be declared in that event's payload_schema: a schema name equal
 * to the key, or a dotted name under it (`task: {...}` is declared by `task.id`). Spreads,
 * computed keys and non-literal payloads are skipped: the guard flags only what it is sure of.
 *
 * The catalog is read as text (no build, no DB). payload_schema entries may be inline objects,
 * identifiers of a `const x: PayloadField = {...}`, or spreads of a `const x: PayloadField[] = [...]`;
 * a schema built any other way is treated as unknown and its event is not key-checked.
 */

/** Advance past a string literal starting at i (the opening quote); returns the index after it. */
function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') {
      j += 1;
      continue;
    }
    if (c === q) return j + 1;
  }
  return src.length;
}

/** Advance past a comment starting at i (`//` or `/*`); returns the index after it, or i when none. */
function skipComment(src, i) {
  if (src[i] !== '/') return i;
  if (src[i + 1] === '/') {
    const nl = src.indexOf('\n', i + 2);
    return nl < 0 ? src.length : nl + 1;
  }
  if (src[i + 1] === '*') {
    const end = src.indexOf('*/', i + 2);
    return end < 0 ? src.length : end + 2;
  }
  return i;
}

/**
 * The balanced bracket text starting at `open` (a `[`, `{` or `(`), including both brackets, or
 * null. Strings and comments are skipped, so brackets and quotes inside them do not count.
 */
export function balancedSlice(src, open) {
  const pairs = { '[': ']', '{': '}', '(': ')' };
  if (!pairs[src[open]]) return null;
  const stack = [];
  for (let i = open; i < src.length; ) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(src, i);
      continue;
    }
    const after = skipComment(src, i);
    if (after !== i) {
      i = after;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ']' || c === '}' || c === ')') {
      if (stack.pop() !== c) return null;
      if (stack.length === 0) return src.slice(open, i + 1);
    }
    i += 1;
  }
  return null;
}

/** Split the inside of a bracketed text at top-level commas (strings, comments and nesting respected). */
export function splitTopLevel(inner) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; ) {
    const c = inner[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(inner, i);
      continue;
    }
    const after = skipComment(inner, i);
    if (after !== i) {
      i = after;
      continue;
    }
    if (c === '[' || c === '{' || c === '(') depth += 1;
    else if (c === ']' || c === '}' || c === ')') depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  out.push(inner.slice(start));
  return out.map(stripComments).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** Remove comments outside strings. */
function stripComments(s) {
  let out = '';
  for (let i = 0; i < s.length; ) {
    const c = s[i];
    if (c === "'" || c === '"' || c === '`') {
      const end = skipString(s, i);
      out += s.slice(i, end);
      i = end;
      continue;
    }
    const after = skipComment(s, i);
    if (after !== i) {
      out += ' ';
      i = after;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * The top-level keys of an object-literal argument, or null when the argument is not an object
 * literal. `{ a, b: 1, 'c-d': 2, [x]: 3, ...rest }` -> { keys: ['a', 'b', 'c-d'], open: true }.
 * `open` is true when a spread or a computed key means the payload may carry keys not listed.
 */
export function objectLiteralKeys(arg) {
  const text = stripComments(arg).trim();
  if (!text.startsWith('{')) return null;
  const whole = balancedSlice(text, 0);
  if (whole === null || whole.length !== text.length) return null;
  const keys = [];
  let open = false;
  for (const part of splitTopLevel(whole.slice(1, -1))) {
    if (part.startsWith('...')) {
      open = true;
      continue;
    }
    if (part.startsWith('[')) {
      open = true;
      continue;
    }
    const q = part[0];
    if (q === "'" || q === '"') {
      const end = skipString(part, 0);
      keys.push(part.slice(1, end - 1));
      continue;
    }
    const m = /^([A-Za-z_$][\w$]*)\s*(?::|$|\()/.exec(part);
    if (m) keys.push(m[1]);
    else open = true;
  }
  return { keys, open };
}

/** Resolve `const <name>(: T)? = <[...] or {...}>` in the catalog text to its literal, or null. */
function constLiteral(src, name) {
  const re = new RegExp(`const\\s+${name.replace(/[$]/g, '\\$')}\\s*(?::[^=]+)?=\\s*`, 'g');
  const m = re.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  while (i < src.length && /\s/.test(src[i])) i += 1;
  return balancedSlice(src, i);
}

/** The `name` of a PayloadField object literal, or null. */
function fieldName(objText) {
  const m = /\bname:\s*(['"])([^'"]+)\1/.exec(objText);
  return m ? m[2] : null;
}

/** Field names of a payload_schema array literal; null when any element cannot be resolved. */
function schemaNames(src, arrayText, depth = 0) {
  if (depth > 5) return null;
  const names = new Set();
  for (const el of splitTopLevel(arrayText.slice(1, -1))) {
    if (el.startsWith('{')) {
      const n = fieldName(el);
      if (n === null) return null;
      names.add(n);
    } else if (el.startsWith('...')) {
      const ident = el.slice(3).trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(ident)) return null;
      const lit = constLiteral(src, ident);
      if (!lit || !lit.startsWith('[')) return null;
      const inner = schemaNames(src, lit, depth + 1);
      if (inner === null) return null;
      for (const n of inner) names.add(n);
    } else if (/^[A-Za-z_$][\w$]*$/.test(el)) {
      const lit = constLiteral(src, el);
      if (!lit || !lit.startsWith('{')) return null;
      const n = fieldName(lit);
      if (n === null) return null;
      names.add(n);
    } else {
      return null;
    }
  }
  return names;
}

const ENTRY_RE = /source:\s*['"]([a-z_]+)['"],\s*event_type:\s*['"]([a-z0-9_.]+)['"]/g;

/**
 * Map of `source:event_type` -> Set of declared payload names, or null when the schema could not be
 * read statically (that event is not key-checked).
 */
export function parsePayloadSchemas(catalogText) {
  const out = new Map();
  ENTRY_RE.lastIndex = 0;
  for (let m = ENTRY_RE.exec(catalogText); m !== null; m = ENTRY_RE.exec(catalogText)) {
    const key = `${m[1]}:${m[2]}`;
    const from = m.index + m[0].length;
    const nextEntry = catalogText.indexOf('event_type:', from);
    const ps = catalogText.indexOf('payload_schema:', from);
    if (ps < 0 || (nextEntry >= 0 && ps > nextEntry)) {
      out.set(key, null);
      continue;
    }
    let i = ps + 'payload_schema:'.length;
    while (i < catalogText.length && /\s/.test(catalogText[i])) i += 1;
    let arrayText = null;
    if (catalogText[i] === '[') arrayText = balancedSlice(catalogText, i);
    else {
      const ident = /^[A-Za-z_$][\w$]*/.exec(catalogText.slice(i))?.[0];
      if (ident) arrayText = constLiteral(catalogText, ident);
    }
    out.set(key, arrayText && arrayText.startsWith('[') ? schemaNames(catalogText, arrayText) : null);
  }
  return out;
}

/** True when `key` is declared by `names` (exactly, or as the parent of a dotted name). */
export function keyDeclared(key, names) {
  if (names.has(key)) return true;
  const prefix = `${key}.`;
  for (const n of names) if (n.startsWith(prefix)) return true;
  return false;
}

const CALLS = [
  // [callee, index of the event-name argument, index of the source argument (or a fixed source), index of the payload argument]
  { re: /(?<![A-Za-z0-9_$.])(publishBoltEvent(?:Checked)?)\s*\(/g, source: 1, payload: 2 },
  { re: /(?<![A-Za-z0-9_$.])(enqueueBastionEvent)\s*\(/g, source: 'bastion', payload: 1 },
];

/** A plain string literal's value, or null. */
function literal(arg) {
  const a = arg.trim();
  const q = a[0];
  if ((q === "'" || q === '"' || q === '`') && a.length >= 2 && a[a.length - 1] === q && !(q === '`' && a.includes('${'))) return a.slice(1, -1);
  return null;
}

/** Payload-key violations for every literal publish call in one file. */
export function checkPayloadCalls(file, text, schemas) {
  const out = [];
  if (!text.includes('publishBoltEvent') && !text.includes('enqueueBastionEvent')) return out;
  for (const call of CALLS) {
    call.re.lastIndex = 0;
    for (let m = call.re.exec(text); m !== null; m = call.re.exec(text)) {
      if (/function\s*\*?\s*$/.test(text.slice(Math.max(0, m.index - 16), m.index))) continue;
      const open = m.index + m[0].length - 1;
      const whole = balancedSlice(text, open);
      if (!whole) continue;
      const args = splitTopLevel(whole.slice(1, -1));
      const eventName = literal(args[0] ?? '');
      const source = typeof call.source === 'string' ? call.source : literal(args[call.source] ?? '');
      const payloadArg = args[call.payload];
      if (!eventName || !source || payloadArg === undefined) continue;
      out.push(...payloadKeyViolations({ file, source, eventName, payloadArg, schemas, callee: m[1] }));
    }
  }
  return out;
}

/**
 * Violations for one payload: every explicit key the call sends that the event's schema does not
 * declare. `schemas` comes from parsePayloadSchemas.
 */
export function payloadKeyViolations({ file, source, eventName, payloadArg, schemas, callee }) {
  const names = schemas.get(`${source}:${eventName}`);
  if (!names) return [];
  const lit = objectLiteralKeys(payloadArg);
  if (!lit) return [];
  const missing = [...new Set(lit.keys.filter((k) => !keyDeclared(k, names)))];
  return missing.map((k) => ({
    file,
    callee,
    eventName,
    source,
    driftKey: `${source}:${eventName}:${k}`,
    reason: `${callee}('${eventName}') sends payload key "${k}" that the catalog's payload_schema for (${source}, ${eventName}) does not declare; declare it in apps/bolt-api/src/services/event-catalog.ts or stop sending it`,
  }));
}

/**
 * Apply the known-drift baseline (scripts/lib/bolt-payload-drift-baseline.json): violations whose
 * driftKey is baselined are dropped, and every baselined key that no call sends any more is
 * reported, so the baseline can only shrink.
 */
export function applyDriftBaseline(violations, baseline, baselineFile) {
  const seen = new Set(violations.map((v) => v.driftKey));
  const kept = violations.filter((v) => !(v.driftKey in baseline));
  const stale = Object.keys(baseline)
    .filter((k) => !seen.has(k))
    .map((k) => ({
      file: baselineFile,
      eventName: k,
      source: k.split(':')[0],
      reason: `baseline entry "${k}" (issue #${baseline[k]}) is no longer sent undeclared; delete it from the baseline`,
    }));
  return [...kept, ...stale];
}
