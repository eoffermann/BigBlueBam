import { describe, it, expect } from 'vitest';
import { mintApiKey, KEY_PREFIX_LENGTH } from '../src/lib/api-key-mint.js';

// Contract: the prefix the helper stores must match what
// apps/api/src/plugins/auth.ts uses to look up the row. If these
// diverge, freshly minted tokens cannot authenticate. These tests pin
// both ends of the contract on the helper itself so any future
// re-introduction of an open-coded slice length fails fast.

describe('mintApiKey contract', () => {
  it('KEY_PREFIX_LENGTH is 8 (matches auth.ts lookup slice)', () => {
    // Hardcoded value mirrors the assumption documented in
    // packages/permissions and apps/api/src/plugins/auth.ts. If the
    // auth-side lookup changes, this test must be updated in lockstep
    // — surfacing the cross-file invariant.
    expect(KEY_PREFIX_LENGTH).toBe(8);
  });

  for (const kind of ['user_legacy', 'user', 'service'] as const) {
    it(`mintApiKey('${kind}') returns keyPrefix === fullToken.slice(0, KEY_PREFIX_LENGTH)`, async () => {
      const result = await mintApiKey(kind);
      expect(result.keyPrefix).toBe(result.fullToken.slice(0, KEY_PREFIX_LENGTH));
      expect(result.keyPrefix.length).toBe(KEY_PREFIX_LENGTH);
    });
  }

  it("mintApiKey('user_legacy') produces a token with no `bbam_` prefix (backward compat)", async () => {
    const result = await mintApiKey('user_legacy');
    expect(result.fullToken.startsWith('bbam_')).toBe(false);
  });

  it("mintApiKey('user') produces a `bbam_`-prefixed token", async () => {
    const result = await mintApiKey('user');
    expect(result.fullToken.startsWith('bbam_')).toBe(true);
    expect(result.fullToken.startsWith('bbam_svc_')).toBe(false);
  });

  it("mintApiKey('service') produces a `bbam_svc_`-prefixed token", async () => {
    const result = await mintApiKey('service');
    expect(result.fullToken.startsWith('bbam_svc_')).toBe(true);
  });

  it('keyHash is a valid argon2id hash of fullToken', async () => {
    const argon2 = (await import('argon2')).default;
    const result = await mintApiKey('service');
    expect(result.keyHash.startsWith('$argon2id$')).toBe(true);
    const ok = await argon2.verify(result.keyHash, result.fullToken);
    expect(ok).toBe(true);
  });

  it('successive mints return distinct tokens', async () => {
    const a = await mintApiKey('service');
    const b = await mintApiKey('service');
    expect(a.fullToken).not.toBe(b.fullToken);
  });
});
