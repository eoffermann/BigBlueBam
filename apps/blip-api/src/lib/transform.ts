/**
 * Blip PII / payload transform (Blip §9). Ordered redaction rules applied at the
 * ingest edge before tail publish and before queueing, so no un-redacted field
 * ever leaves the request thread. Matching is by explicit field path, glob, or
 * regex on keys; actions are drop / mask / hash / truncate. A global per-string
 * length cap is always applied as a floor regardless of rules.
 */
import { createHmac } from 'node:crypto';

export type TransformRule = {
  match: string; // 'payload:user.email' | 'glob:*token*' | 'regex:...'
  action: 'drop' | 'mask' | 'hash' | 'truncate';
  params?: { keep_last?: number; max_len?: number };
};

const GLOBAL_STRING_CAP = 8192; // hard floor; runaway log lines can never store unbounded text

type Matcher = (keyPath: string) => boolean;

function buildMatcher(match: string): Matcher {
  if (match.startsWith('payload:')) {
    const target = match.slice('payload:'.length);
    return (keyPath) => keyPath === target;
  }
  if (match.startsWith('glob:')) {
    const pat = match.slice('glob:'.length);
    const re = new RegExp(
      '^' + pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
      'i',
    );
    return (keyPath) => re.test(keyPath) || re.test(keyPath.split('.').pop() ?? '');
  }
  if (match.startsWith('regex:')) {
    let re: RegExp;
    try {
      re = new RegExp(match.slice('regex:'.length), 'i');
    } catch {
      re = /^\b$/; // invalid regex matches nothing
    }
    return (keyPath) => re.test(keyPath) || re.test(keyPath.split('.').pop() ?? '');
  }
  // bare path
  return (keyPath) => keyPath === match;
}

export type CompiledTransform = {
  version: number;
  apply: (payload: Record<string, unknown>) => Record<string, unknown>;
};

export function compileTransform(
  rules: TransformRule[],
  version: number,
  pepper: string,
): CompiledTransform {
  const compiled = rules.map((r) => ({ ...r, matcher: buildMatcher(r.match) }));

  function maskValue(rule: TransformRule, value: unknown): unknown {
    const s = String(value);
    switch (rule.action) {
      case 'drop':
        return undefined;
      case 'mask': {
        const keep = rule.params?.keep_last ?? 0;
        const tail = keep > 0 ? s.slice(-keep) : '';
        return `***${tail}`;
      }
      case 'hash':
        return createHmac('sha256', pepper).update(s).digest('hex').slice(0, 32);
      case 'truncate':
        return s.slice(0, rule.params?.max_len ?? 256);
      default:
        return value;
    }
  }

  function walk(obj: Record<string, unknown>, prefix: string): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const keyPath = prefix ? `${prefix}.${k}` : k;
      const rule = compiled.find((r) => r.matcher(keyPath));
      if (rule) {
        const masked = maskValue(rule, v);
        if (masked !== undefined) out[k] = capStrings(masked);
        continue; // dropped or replaced; do not recurse into a redacted subtree
      }
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = walk(v as Record<string, unknown>, keyPath);
      } else {
        out[k] = capStrings(v);
      }
    }
    return out;
  }

  function capStrings(v: unknown): unknown {
    if (typeof v === 'string' && v.length > GLOBAL_STRING_CAP) return v.slice(0, GLOBAL_STRING_CAP);
    return v;
  }

  return {
    version,
    apply: (payload) => walk(payload, ''),
  };
}
