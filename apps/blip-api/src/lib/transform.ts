/**
 * Blip PII / payload transform (Blip §9). Ordered redaction rules applied at the
 * ingest edge before tail publish and before queueing, so no un-redacted field
 * ever leaves the request thread. Matching is by explicit field path, glob, or
 * regex on keys; actions are drop / mask / hash / truncate / pseudonymize. A
 * global per-string length cap is always applied as a floor regardless of rules.
 *
 * `hash` uses the static ingest pepper, so the same input always yields the same
 * output forever; anyone holding the pepper and the raw value elsewhere (e.g. a
 * device id also stored by another service) can re-link it. `pseudonymize`
 * instead keys the HMAC with a random salt that exists only for the current UTC
 * period (day / ISO week / calendar month) and is deleted when the period ends.
 * Within a period the same input maps to the same pseudonym (unique counts,
 * retention, per-install grouping keep working); once the salt is gone, past
 * pseudonyms cannot be linked to anything. Unknown actions drop the field
 * (fail closed) rather than storing the raw value. A rule with
 * `params.unless: { field, at_least }` is skipped for payloads whose numeric
 * field is at least that value (e.g. builds that already clean the field).
 */
import { createHmac } from 'node:crypto';

export type PseudonymPeriod = 'day' | 'week' | 'month';

/**
 * Skip a rule for payloads whose numeric field (dot path from the payload root)
 * is at least `at_least`, e.g. clients that already clean a field themselves
 * from some schema version on. A missing or non-numeric field means the rule
 * applies (fail closed).
 */
export type RuleCondition = { field: string; at_least: number };

export type TransformRule = {
  match: string; // 'payload:user.email' | 'glob:*token*' | 'regex:...'
  action: 'drop' | 'mask' | 'hash' | 'truncate' | 'pseudonymize';
  params?: {
    keep_last?: number;
    max_len?: number;
    period?: PseudonymPeriod;
    unless?: RuleCondition;
  };
};

function conditionMet(payload: Record<string, unknown>, cond: RuleCondition): boolean {
  let v: unknown = payload;
  for (const k of cond.field.split('.')) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
    v = (v as Record<string, unknown>)[k];
  }
  return typeof v === 'number' && Number.isFinite(v) && v >= cond.at_least;
}

/** Per-batch salt lookup for `pseudonymize`; null means no salt (drop the field). */
export type SaltLookup = (period: PseudonymPeriod) => string | null;

export const PSEUDONYM_PERIODS: readonly PseudonymPeriod[] = ['day', 'week', 'month'];

export function rulePeriod(rule: TransformRule): PseudonymPeriod {
  const p = rule.params?.period;
  return p && PSEUDONYM_PERIODS.includes(p) ? p : 'month';
}

/** Periods any `pseudonymize` rule in the set needs a salt for. */
export function pseudonymPeriods(rules: TransformRule[]): PseudonymPeriod[] {
  const out = new Set<PseudonymPeriod>();
  for (const r of rules) if (r.action === 'pseudonymize') out.add(rulePeriod(r));
  return [...out];
}

/**
 * The UTC period containing `at`: a stable label (part of the salt key) and the
 * instant the period ends (when its salt must be gone).
 */
export function periodWindow(period: PseudonymPeriod, at: Date): { label: string; endsAt: Date } {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  const d = at.getUTCDate();
  if (period === 'day') {
    return {
      label: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`,
      endsAt: new Date(Date.UTC(y, m, d + 1)),
    };
  }
  if (period === 'week') {
    // ISO week: Monday start. Label by the Monday's date.
    const dow = (at.getUTCDay() + 6) % 7; // 0 = Monday
    const monday = new Date(Date.UTC(y, m, d - dow));
    const label = `w${monday.toISOString().slice(0, 10)}`;
    return { label, endsAt: new Date(Date.UTC(y, m, d - dow + 7)) };
  }
  return {
    label: `${y}-${String(m + 1).padStart(2, '0')}`,
    endsAt: new Date(Date.UTC(y, m + 1, 1)),
  };
}

const GLOBAL_STRING_CAP = 8192; // hard floor; runaway log lines can never store unbounded text

type Matcher = (keyPath: string) => boolean;

function buildMatcher(match: string): Matcher {
  if (match.startsWith('payload:')) {
    const target = match.slice('payload:'.length);
    return (keyPath) => keyPath === target;
  }
  if (match.startsWith('glob:')) {
    const pat = match.slice('glob:'.length);
    const body = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
    const re = new RegExp(`^${body}$`, 'i');
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
  apply: (payload: Record<string, unknown>, salts?: SaltLookup) => Record<string, unknown>;
};

export function compileTransform(
  rules: TransformRule[],
  version: number,
  pepper: string,
): CompiledTransform {
  const compiled = rules.map((r) => ({ ...r, matcher: buildMatcher(r.match) }));

  function maskValue(rule: TransformRule, value: unknown, salts?: SaltLookup): unknown {
    const s = String(value);
    switch (rule.action) {
      case 'pseudonymize': {
        if (value == null || value === '') return value;
        const salt = salts?.(rulePeriod(rule)) ?? null;
        if (!salt) return undefined; // no period salt available: never store the raw id
        return createHmac('sha256', salt).update(s).digest('hex').slice(0, 32);
      }
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
        return undefined; // unknown action: fail closed
    }
  }

  type Compiled = (typeof compiled)[number];

  function walk(
    obj: Record<string, unknown>,
    prefix: string,
    active: Compiled[],
    salts?: SaltLookup,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const keyPath = prefix ? `${prefix}.${k}` : k;
      const rule = active.find((r) => r.matcher(keyPath));
      if (rule) {
        const masked = maskValue(rule, v, salts);
        if (masked !== undefined) out[k] = capStrings(masked);
        continue; // dropped or replaced; do not recurse into a redacted subtree
      }
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        out[k] = walk(v as Record<string, unknown>, keyPath, active, salts);
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
    apply: (payload, salts) => {
      // Conditions read the untransformed payload, so a rule earlier in the list
      // cannot switch a later one off by rewriting the field it checks.
      const active = compiled.filter(
        (r) => !r.params?.unless || !conditionMet(payload, r.params.unless),
      );
      return walk(payload, '', active, salts);
    },
  };
}
