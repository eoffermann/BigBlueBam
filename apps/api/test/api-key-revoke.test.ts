// #390: every service-account key is stored with key_prefix 'bbam_svc', so `cli revoke-api-key
// --prefix bbam_svc` cannot name one of them. The CLI now also selects by a fragment of the unique
// key_lookup (--lookup) or by key name and owner (--name / --email), and any selector matching
// more than one key is refused with the candidates (id, ref, name, owner) listed.
import { describe, expect, it } from 'vitest';
import { apiKeyLookup } from '@bigbluebam/auth-core';
import {
  LOOKUP_REF_LENGTH,
  lookupRef,
  parseRevokeSelector,
  resolveRevokeTarget,
  type RevokeCandidate,
} from '../src/lib/api-key-revoke.js';

const ID_A = '0a0a0a0a-0000-4000-8000-00000000000a';
const ID_B = '0b0b0b0b-0000-4000-8000-00000000000b';

function svcKey(id: string, name: string, email: string, token: string): RevokeCandidate {
  return { id, name, user_email: email, key_prefix: 'bbam_svc', key_lookup: apiKeyLookup(token) };
}

const A = svcKey(ID_A, 'mcp-internal (service account)', 'svc+mcp-internal-acme@system.local', 'bbam_svc_aaa');
const B = svcKey(ID_B, 'bolt-runner (service account)', 'svc+bolt-runner-acme@system.local', 'bbam_svc_bbb');

function parse(flags: Record<string, string>) {
  const r = parseRevokeSelector(flags);
  if (!r.ok) throw new Error(`unexpected parse error: ${r.error}`);
  return r.selector;
}

describe('revoke-api-key selector (#390)', () => {
  it('refuses --prefix bbam_svc when it matches several service-account keys, listing each by id, ref and name', () => {
    const r = resolveRevokeTarget([A, B], parse({ prefix: 'bbam_svc' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toMatch(/prefix "bbam_svc" matches 2 keys; nothing was revoked/);
    for (const k of [A, B]) {
      expect(r.error).toContain(k.id);
      expect(r.error).toContain(`ref=${lookupRef(k.key_lookup)}`);
      expect(r.error).toContain(`name="${k.name}"`);
      expect(r.error).toContain(`owner=${k.user_email}`);
    }
  });

  it('names one service-account key by a fragment of its lookup id', () => {
    const ref = lookupRef(B.key_lookup) ?? '';
    expect(ref).toHaveLength(LOOKUP_REF_LENGTH);
    const selector = parse({ lookup: ref.toUpperCase() });
    expect(selector).toEqual({ kind: 'lookup', fragment: ref, id: undefined });
    const r = resolveRevokeTarget([B], selector);
    expect(r.ok && r.target.id).toBe(ID_B);
  });

  it('names a key by name and owner', () => {
    const selector = parse({ name: A.name, email: A.user_email ?? '' });
    expect(selector).toEqual({ kind: 'name', name: A.name, email: A.user_email, id: undefined });
    const r = resolveRevokeTarget([A], selector);
    expect(r.ok && r.target.id).toBe(ID_A);
  });

  it('a name shared by two keys is refused, and --id picks among the matches', () => {
    const twin = { ...B, name: A.name };
    const ambiguous = resolveRevokeTarget([A, twin], parse({ name: A.name }));
    expect(ambiguous.ok).toBe(false);
    const pinned = resolveRevokeTarget([A, twin], parse({ name: A.name, id: ID_B }));
    expect(pinned.ok && pinned.target.id).toBe(ID_B);
  });

  it('--prefix with --id still works, and an --id outside the matches is refused', () => {
    const ok = resolveRevokeTarget([A, B], parse({ prefix: 'bbam_svc', id: ID_A }));
    expect(ok.ok && ok.target.id).toBe(ID_A);
    const miss = resolveRevokeTarget([A], parse({ prefix: 'bbam_svc', id: ID_B }));
    expect(miss.ok).toBe(false);
  });

  it('a single key matching --prefix is revoked as before', () => {
    const user = { ...A, key_prefix: 'bbam_abc' };
    const r = resolveRevokeTarget([user], parse({ prefix: 'bbam_abc' }));
    expect(r.ok && r.target.id).toBe(ID_A);
  });

  it('no match is a refusal', () => {
    const r = resolveRevokeTarget([], parse({ lookup: 'deadbeef' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('no API key matches lookup deadbeef');
  });

  it('a legacy key without a lookup id is listed with a hint to use --id', () => {
    const legacy = { ...A, key_lookup: null };
    const r = resolveRevokeTarget([legacy, B], parse({ prefix: 'bbam_svc' }));
    expect(!r.ok && r.error).toContain('ref=(none: legacy key, use --id)');
  });

  it('rejects flag combinations that do not name exactly one selector', () => {
    const bad = (flags: Record<string, string>) => {
      const r = parseRevokeSelector(flags);
      expect(r.ok).toBe(false);
      return r.ok ? '' : r.error;
    };
    expect(bad({})).toMatch(/no key named/);
    expect(bad({ prefix: 'bbam_svc', lookup: 'deadbeef' })).toMatch(/use one of --lookup, --prefix, --name/);
    expect(bad({ email: 'a@b.c' })).toMatch(/--email narrows --name/);
    expect(bad({ lookup: 'abc' })).toMatch(/8 to 64 hex characters/);
    expect(bad({ lookup: 'zzzzzzzz' })).toMatch(/hex characters/);
    expect(bad({ lookup: 'deadbeef%' })).toMatch(/hex characters/);
    expect(bad({ id: 'not-a-uuid' })).toMatch(/is not a key id/);
  });

  it('--id alone selects by id', () => {
    expect(parse({ id: ID_A })).toEqual({ kind: 'id', id: ID_A });
    const r = resolveRevokeTarget([A], parse({ id: ID_A }));
    expect(r.ok && r.target.id).toBe(ID_A);
  });
});
