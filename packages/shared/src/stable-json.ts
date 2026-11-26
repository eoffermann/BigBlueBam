// Canonical JSON for cache keys and fingerprints (#275). Pure, no node imports (browser-safe).
//
// Object keys are sorted at EVERY depth, arrays keep their order, and `undefined` object members
// are dropped (as JSON.stringify does). Two values that JSON-serialize to the same data produce the
// same string whatever their key order; values that differ anywhere, at any depth, do not.
//
// Never build a key with `JSON.stringify(value, Object.keys(value).sort())`: an array replacer is
// a property ALLOWLIST applied at every nesting level, so every nested object serializes as `{}`
// and different queries collide (#275, Bench's ad-hoc result cache).

function canonical(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (typeof (value as { toJSON?: unknown }).toJSON === 'function') {
    return canonical((value as { toJSON: () => unknown }).toJSON());
  }
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonical(v)));
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const v = (value as Record<string, unknown>)[key];
    if (v !== undefined && typeof v !== 'function' && typeof v !== 'symbol') out[key] = canonical(v);
  }
  return out;
}

/** JSON with object keys sorted at every depth. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonical(value)) ?? 'null';
}
