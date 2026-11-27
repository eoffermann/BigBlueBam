import { describe, it, expect } from 'vitest';
import {
  isReadMethod,
  keyActingOrgId,
  orgAdminSurfaceDecision,
  scopeDecision,
  scopeForMethod,
  type ScopedUser,
} from './index.js';

// #351: helpdesk-api's request.user is a portal customer, so its Bam-key guards cannot use the
// requireScope preHandler. These pure forms carry the same rules so helpdesk stops re-deriving them.

const ORG_A = 'org-a';
const ORG_B = 'org-b';

function user(over: Partial<ScopedUser> = {}): ScopedUser {
  return { id: 'u1', role: 'member', is_superuser: false, api_key_scope: null, kind: 'human', ...over };
}

describe('scopeDecision (the requireScope rule as a pure function)', () => {
  it('SuperUsers pass every scope, whatever their key scope', () => {
    expect(scopeDecision(user({ is_superuser: true, api_key_scope: 'read' }), 'admin')).toBeNull();
  });

  it('a key below the needed scope is refused with the scope message', () => {
    const d = scopeDecision(user({ api_key_scope: 'read' }), 'read_write');
    expect(d?.status).toBe(403);
    expect(d?.message).toMatch(/'read_write' scope/);
  });

  it("an admin-scope key is capped by a human holder's current role (#336), not a service holder's", () => {
    expect(scopeDecision(user({ api_key_scope: 'admin', role: 'member' }), 'admin')?.log).toMatch(/no longer/);
    expect(scopeDecision(user({ api_key_scope: 'admin', role: 'admin' }), 'admin')).toBeNull();
    expect(scopeDecision(user({ api_key_scope: 'admin', role: 'member', kind: 'service' }), 'admin')).toBeNull();
  });

  it('a session needs an admin role only for admin', () => {
    expect(scopeDecision(user(), 'read_write')).toBeNull();
    expect(scopeDecision(user(), 'admin')).not.toBeNull();
    expect(scopeDecision(user({ role: 'owner' }), 'admin')).toBeNull();
  });
});

describe('scopeForMethod / isReadMethod', () => {
  it('maps reads to the read scope and everything else to the write scope', () => {
    expect(scopeForMethod('GET', 'read', 'read_write')).toBe('read');
    expect(scopeForMethod('HEAD', 'read', 'read_write')).toBe('read');
    expect(scopeForMethod('PATCH', 'read', 'read_write')).toBe('read_write');
    expect(scopeForMethod('DELETE', 'read', 'admin')).toBe('admin');
    expect(isReadMethod('POST')).toBe(false);
  });
});

describe('orgAdminSurfaceDecision', () => {
  it('writes are exactly requireScope(admin)', () => {
    expect(orgAdminSurfaceDecision(user({ api_key_scope: 'read', role: 'admin' }), 'PATCH')).not.toBeNull();
    expect(orgAdminSurfaceDecision(user({ api_key_scope: 'admin', role: 'admin' }), 'PATCH')).toBeNull();
    expect(orgAdminSurfaceDecision(user({ is_superuser: true, api_key_scope: 'read' }), 'PATCH')).toBeNull();
  });

  it('reads also admit a current org admin with any key scope, never a non-admin', () => {
    expect(orgAdminSurfaceDecision(user({ api_key_scope: 'read', role: 'admin' }), 'GET')).toBeNull();
    expect(orgAdminSurfaceDecision(user({ api_key_scope: 'admin', role: 'viewer' }), 'GET')).not.toBeNull();
    expect(orgAdminSurfaceDecision(user({ api_key_scope: 'read', role: 'member', kind: 'service' }), 'GET')).not.toBeNull();
    expect(orgAdminSurfaceDecision(user({ role: 'member' }), 'GET')).not.toBeNull();
  });
});

describe('keyActingOrgId', () => {
  it("a pinned key acts in its own org; SuperUser and NULL-org keys act in the host's unpinned org", () => {
    expect(keyActingOrgId(ORG_A, false, ORG_B)).toBe(ORG_A);
    expect(keyActingOrgId(ORG_A, true, ORG_B)).toBe(ORG_B);
    expect(keyActingOrgId(null, false, ORG_B)).toBe(ORG_B);
    expect(keyActingOrgId(null, false, null)).toBeNull();
  });
});
