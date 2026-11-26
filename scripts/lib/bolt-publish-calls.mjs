/**
 * The per-file publish-call scan of the Bolt catalog guard (scripts/check-bolt-catalog.mjs).
 *
 * Every positional publisher in @bigbluebam/shared is scanned the same way (issue #200):
 * `publishBoltEvent(` and `publishBoltEventChecked(` (the outbox-friendly sibling that reports
 * delivery). Both take (eventType, source, payload, orgId, ...), so the first two string-literal
 * arguments are the (event name, source) pair to verify. A name that is only a prefix match
 * (`publishBoltEventsLater(`) or a declaration's identifier followed by something other than
 * `(` is not a call.
 */

/** The publisher function names whose literal calls are checked. */
export const PUBLISH_FUNCTIONS = ['publishBoltEvent', 'publishBoltEventChecked'];

// Word-bounded on both sides, then optional whitespace and `(`.
const CALL_RE = /(?<![A-Za-z0-9_$])(publishBoltEvent(?:Checked)?)(?![A-Za-z0-9_$])\s*\(/g;

/**
 * Balanced-paren walker: given `src` and a start index pointing at the `(` after the callee,
 * returns the slice of arguments between `(` and the matching `)`. Tracks string/template
 * literals so parens inside them do not confuse the walker.
 */
export function extractArgs(src, openIdx) {
  let depth = 0;
  let inString = null;
  let escaped = false;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === '\\') escaped = true;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inString = c;
      continue;
    }
    if (c === '(') depth += 1;
    else if (c === ')') {
      depth -= 1;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return null;
}

/**
 * Top-level comma-aware argument splitter. Respects nested parens/brackets/braces and strings
 * so `{ foo: bar(1, 2) }` counts as a single argument.
 */
export function splitTopLevelArgs(argText) {
  const out = [];
  let depth = 0;
  let inString = null;
  let escaped = false;
  let start = 0;
  for (let i = 0; i < argText.length; i++) {
    const c = argText[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (c === '\\') escaped = true;
      else if (c === inString) inString = null;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      inString = c;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(argText.slice(start, i));
      start = i + 1;
    }
  }
  if (start < argText.length) out.push(argText.slice(start));
  return out.map((s) => s.trim());
}

/**
 * Parse a string literal argument: { ok, value } where value is the string content if the arg
 * is a plain single/double-quoted literal. Template literals with `${}` interpolation are
 * rejected (they cannot be verified statically); plain backtick literals are accepted.
 */
export function parseStringLiteralArg(arg) {
  if (arg.length < 2) return { ok: false, value: null };
  const first = arg[0];
  const last = arg[arg.length - 1];
  if ((first === "'" || first === '"') && last === first) return { ok: true, value: arg.slice(1, -1) };
  if (first === '`' && last === '`') {
    const inner = arg.slice(1, -1);
    if (inner.includes('${')) return { ok: false, value: null };
    return { ok: true, value: inner };
  }
  return { ok: false, value: null };
}

/**
 * Violations for every literal publish call in one file.
 * `catalog`: { pairs: Set<'source:event'>, sources: Set<string>, boltSources?: Set<string> }.
 * Dynamic (non-literal) calls are allowed: the guard flags only what it is certain about.
 */
export function checkPublishCalls(file, text, catalog, legacyAllowlist = new Set()) {
  const violations = [];
  if (!text.includes('publishBoltEvent')) return violations;
  CALL_RE.lastIndex = 0;
  for (let m = CALL_RE.exec(text); m !== null; m = CALL_RE.exec(text)) {
    const callee = m[1];
    const open = m.index + m[0].length - 1;
    const argText = extractArgs(text, open);
    if (argText === null) continue;
    const args = splitTopLevelArgs(argText);
    if (args.length < 2) continue; // malformed or a declaration's parameter list; skip quietly

    const eventLit = parseStringLiteralArg(args[0]);
    const sourceLit = parseStringLiteralArg(args[1]);
    if (!eventLit.ok || !sourceLit.ok) continue;

    const eventName = eventLit.value;
    const source = sourceLit.value;
    const key = `${source}:${eventName}`;

    // Rule 1: event name must be bare (no dotted source prefix).
    if (catalog.sources.has(eventName.split('.')[0]) && eventName.split('.').length > 2 && !legacyAllowlist.has(key)) {
      violations.push({
        file,
        callee,
        eventName,
        source,
        reason: `event name "${eventName}" looks source-prefixed; use bare event name (e.g. "deal.rotting" not "bond.deal.rotting")`,
      });
      continue;
    }

    // Allowlisted legacy-prefixed events bypass the catalog lookup too.
    if (legacyAllowlist.has(key)) continue;

    // Rule 2a (issue #124): the source must be in the shared BOLT_SOURCES list, or bolt-api
    // ingest 400-rejects it.
    if (catalog.boltSources && !catalog.boltSources.has(source)) {
      violations.push({
        file,
        callee,
        eventName,
        source,
        reason: `source "${source}" is not in BOLT_SOURCES (packages/shared/src/bolt-sources.ts); bolt-api ingest would reject it`,
      });
      continue;
    }

    // Rule 2: (source, eventName) pair must exist in the catalog.
    if (!catalog.pairs.has(key)) {
      violations.push({
        file,
        callee,
        eventName,
        source,
        reason: `(source="${source}", event_type="${eventName}") not found in event-catalog.ts`,
      });
    }
  }
  return violations;
}
