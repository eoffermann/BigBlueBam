// How the CLI `revoke-api-key` command picks exactly one api_keys row (#390).
//
// key_prefix is only the first 8 characters of the token, so every service-account key shares
// key_prefix 'bbam_svc' and --prefix alone cannot name one of them. Since #353 every key minted
// carries key_lookup (hex SHA-256 of the token, unique), whose leading characters are a safe,
// displayable reference: --lookup accepts such a fragment. --name (+ optional --email for the
// owner) names a key the way an operator thinks of it. Whatever the selector, a match on more
// than one key is refused with the candidates listed, never resolved by picking the first row.

/** Hex characters of key_lookup shown as a key's displayable reference. */
export const LOOKUP_REF_LENGTH = 12;
/** Shortest --lookup fragment accepted (shorter fragments are too likely to collide). */
export const MIN_LOOKUP_FRAGMENT = 8;

export type RevokeSelector =
  | { kind: 'id'; id: string }
  | { kind: 'lookup'; fragment: string; id?: string }
  | { kind: 'prefix'; prefix: string; id?: string }
  | { kind: 'name'; name: string; email?: string; id?: string };

export interface RevokeCandidate {
  id: string;
  name: string;
  user_email: string | null;
  key_prefix: string;
  key_lookup: string | null;
}

export type ParseResult = { ok: true; selector: RevokeSelector } | { ok: false; error: string };
export type ResolveResult = { ok: true; target: RevokeCandidate } | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_RE = /^[0-9a-f]+$/;

/** The displayable reference for a key: the first LOOKUP_REF_LENGTH hex chars of key_lookup. */
export function lookupRef(keyLookup: string | null | undefined): string | null {
  return keyLookup ? keyLookup.slice(0, LOOKUP_REF_LENGTH) : null;
}

export const SELECTOR_USAGE =
  'pick the key with --lookup <ref> (from the key list), --name <key name> [--email <owner>], ' +
  '--prefix <8-char prefix>, or --id <uuid>';

/** Turn CLI flags into one selector, or a message saying why the flags do not name a key. */
export function parseRevokeSelector(flags: Record<string, string | undefined>): ParseResult {
  const id = flags.id?.trim() || undefined;
  const lookup = flags.lookup?.trim().toLowerCase() || undefined;
  const prefix = flags.prefix?.trim() || undefined;
  const name = flags.name?.trim() || undefined;
  const email = flags.email?.trim() || undefined;

  if (id && !UUID_RE.test(id)) return { ok: false, error: `--id "${id}" is not a key id (uuid)` };

  const given = [lookup && '--lookup', prefix && '--prefix', name && '--name'].filter(Boolean);
  if (given.length > 1) {
    return { ok: false, error: `use one of --lookup, --prefix, --name (got ${given.join(', ')})` };
  }
  if (email && !name) return { ok: false, error: '--email narrows --name; pass --name too' };

  if (lookup) {
    if (!HEX_RE.test(lookup) || lookup.length < MIN_LOOKUP_FRAGMENT || lookup.length > 64) {
      return {
        ok: false,
        error: `--lookup must be ${MIN_LOOKUP_FRAGMENT} to 64 hex characters of the key's lookup id`,
      };
    }
    return { ok: true, selector: { kind: 'lookup', fragment: lookup, id } };
  }
  if (prefix) return { ok: true, selector: { kind: 'prefix', prefix, id } };
  if (name) return { ok: true, selector: { kind: 'name', name, email, id } };
  if (id) return { ok: true, selector: { kind: 'id', id } };
  return { ok: false, error: `no key named: ${SELECTOR_USAGE}` };
}

export function describeSelector(s: RevokeSelector): string {
  switch (s.kind) {
    case 'id':
      return `id ${s.id}`;
    case 'lookup':
      return `lookup ${s.fragment}`;
    case 'prefix':
      return `prefix "${s.prefix}"`;
    case 'name':
      return s.email ? `name "${s.name}" owned by ${s.email}` : `name "${s.name}"`;
  }
}

export function formatCandidate(c: RevokeCandidate): string {
  const ref = lookupRef(c.key_lookup) ?? '(none: legacy key, use --id)';
  return `  ${c.id}  ref=${ref}  name="${c.name}"  owner=${c.user_email ?? '(deleted user)'}  prefix=${c.key_prefix}`;
}

/**
 * Pick the single key the selector names from the rows it matched. Zero rows, an --id that is
 * not among them, or more than one row without --id are all refusals; the ambiguous case lists
 * every candidate with the references that would name it uniquely.
 */
export function resolveRevokeTarget(rows: RevokeCandidate[], selector: RevokeSelector): ResolveResult {
  const what = describeSelector(selector);
  if (rows.length === 0) return { ok: false, error: `no API key matches ${what}` };

  const pinned = selector.id;
  if (pinned) {
    const target = rows.find((r) => r.id.toLowerCase() === pinned.toLowerCase());
    if (!target) return { ok: false, error: `--id ${pinned} is not one of the keys matching ${what}` };
    return { ok: true, target };
  }

  const [only, ...rest] = rows;
  if (!only) return { ok: false, error: `no API key matches ${what}` };
  if (rest.length > 0) {
    return {
      ok: false,
      error:
        `${what} matches ${rows.length} keys; nothing was revoked. Re-run naming one of them ` +
        `with --lookup <ref> or --id <uuid>:\n${rows.map(formatCandidate).join('\n')}`,
    };
  }
  return { ok: true, target: only };
}
