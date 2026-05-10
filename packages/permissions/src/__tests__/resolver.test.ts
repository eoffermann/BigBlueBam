import { describe, expect, it } from 'vitest';
import { resolve, can } from '../resolver.js';
import type { PermissionContext } from '../types.js';

function makeCtx(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    subject: {
      id: 'u1',
      is_superuser: false,
      kind: 'human',
      api_key_scope: null,
    },
    memberships: [],
    account_overrides: [],
    group_defaults: new Map(),
    ...overrides,
  };
}

describe('resolver — short-circuits', () => {
  it('superuser bypasses everything', () => {
    const ctx = makeCtx({
      subject: { id: 'u1', is_superuser: true, kind: 'human', api_key_scope: null },
    });
    const r = resolve(ctx, 'platform.org.delete', { org_id: 'o1' });
    expect(r.decision).toBe('allow');
    expect(r.reason).toBe('superuser_bypass');
  });

  it('always-permitted core is allowed without any group/membership', () => {
    const r = resolve(makeCtx(), 'platform.system.get_info', { org_id: null });
    expect(r.decision).toBe('allow');
    expect(r.reason).toBe('always_permitted_core');
  });

  it('always-permitted core works for agents whose policy is disabled', () => {
    const ctx = makeCtx({
      subject: { id: 'a1', is_superuser: false, kind: 'agent', api_key_scope: null },
      agent_policy: { enabled: false, allowed_tools: [] },
    });
    const r = resolve(ctx, 'agent.self.heartbeat', { org_id: 'o1' });
    expect(r.decision).toBe('allow');
    expect(r.reason).toBe('always_permitted_core');
  });
});

describe('resolver — api-key scope ceiling', () => {
  it('read-scope key denies a write', () => {
    const ctx = makeCtx({
      subject: { id: 'u1', is_superuser: false, kind: 'human', api_key_scope: 'read' },
    });
    const r = resolve(ctx, 'bam.task.create', { org_id: 'o1' });
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('api_key_ceiling_exceeded');
  });

  it('read-scope key allows a list', () => {
    const ctx = makeCtx({
      subject: { id: 'u1', is_superuser: false, kind: 'human', api_key_scope: 'read' },
      memberships: [{ group_id: 'g1', scope_type: 'org', scope_id: 'o1', detached_at: null }],
      group_defaults: new Map([['g1:bam.task.list', true]]),
    });
    const r = resolve(ctx, 'bam.task.list', { org_id: 'o1' });
    expect(r.decision).toBe('allow');
  });

  it('read_write scope key denies delete verbs', () => {
    const ctx = makeCtx({
      subject: { id: 'u1', is_superuser: false, kind: 'human', api_key_scope: 'read_write' },
    });
    const r = resolve(ctx, 'bam.task.delete', { org_id: 'o1' });
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('api_key_ceiling_exceeded');
  });

  it('admin scope key has no ceiling', () => {
    const ctx = makeCtx({
      subject: { id: 'u1', is_superuser: false, kind: 'human', api_key_scope: 'admin' },
      memberships: [{ group_id: 'g1', scope_type: 'org', scope_id: 'o1', detached_at: null }],
      group_defaults: new Map([['g1:bam.task.delete', true]]),
    });
    const r = resolve(ctx, 'bam.task.delete', { org_id: 'o1' });
    expect(r.decision).toBe('allow');
  });
});

describe('resolver — agent policy gate', () => {
  it('denies when agent has no policy', () => {
    const ctx = makeCtx({
      subject: { id: 'a1', is_superuser: false, kind: 'agent', api_key_scope: null },
    });
    const r = resolve(ctx, 'bam.task.create', { org_id: 'o1' });
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('agent_disabled');
  });

  it('denies when agent policy is disabled', () => {
    const ctx = makeCtx({
      subject: { id: 'a1', is_superuser: false, kind: 'agent', api_key_scope: null },
      agent_policy: { enabled: false, allowed_tools: ['*'] },
    });
    const r = resolve(ctx, 'bam.task.create', { org_id: 'o1' });
    expect(r.reason).toBe('agent_disabled');
  });

  it('respects glob allowlist (banter.*)', () => {
    const ctx = makeCtx({
      subject: { id: 'a1', is_superuser: false, kind: 'agent', api_key_scope: null },
      agent_policy: { enabled: true, allowed_tools: ['banter.*'] },
      memberships: [{ group_id: 'g1', scope_type: 'org', scope_id: 'o1', detached_at: null }],
      group_defaults: new Map([
        ['g1:banter.message.create', true],
        ['g1:bond.deal.create', true],
      ]),
    });
    expect(resolve(ctx, 'banter.message.create', { org_id: 'o1' }).decision).toBe('allow');
    const denied = resolve(ctx, 'bond.deal.create', { org_id: 'o1' });
    expect(denied.decision).toBe('deny');
    expect(denied.reason).toBe('agent_tool_not_allowed');
  });
});

describe('resolver — group defaults (live attachment)', () => {
  it('reads group default at org scope', () => {
    const ctx = makeCtx({
      memberships: [{ group_id: 'g1', scope_type: 'org', scope_id: 'o1', detached_at: null }],
      group_defaults: new Map([['g1:bam.task.create', true]]),
    });
    const r = resolve(ctx, 'bam.task.create', { org_id: 'o1' });
    expect(r.decision).toBe('allow');
    expect(r.reason).toBe('org_group_default');
    expect(r.group_id).toBe('g1');
  });

  it('falls through to next scope when group has no default for permission', () => {
    const ctx = makeCtx({
      memberships: [
        { group_id: 'g1', scope_type: 'org', scope_id: 'o1', detached_at: null },
        { group_id: 'g0', scope_type: 'global', scope_id: null, detached_at: null },
      ],
      // org group g1 doesn't define this permission; global group g0 does.
      group_defaults: new Map([['g0:bam.task.create', true]]),
    });
    const r = resolve(ctx, 'bam.task.create', { org_id: 'o1' });
    expect(r.decision).toBe('allow');
    expect(r.reason).toBe('global_group_default');
  });

  it('project scope wins over org scope', () => {
    const ctx = makeCtx({
      memberships: [
        { group_id: 'gOrg', scope_type: 'org', scope_id: 'o1', detached_at: null },
        { group_id: 'gProj', scope_type: 'project', scope_id: 'p1', detached_at: null },
      ],
      group_defaults: new Map([
        ['gOrg:bam.task.delete', true],
        ['gProj:bam.task.delete', false],
      ]),
    });
    const r = resolve(ctx, 'bam.task.delete', { org_id: 'o1', project_id: 'p1' });
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('project_group_default');
  });
});

describe('resolver — overrides + detachment', () => {
  it('explicit override wins over group default at same scope (race window)', () => {
    const ctx = makeCtx({
      memberships: [{ group_id: 'g1', scope_type: 'org', scope_id: 'o1', detached_at: null }],
      group_defaults: new Map([['g1:bam.task.delete', true]]),
      account_overrides: [
        { scope_type: 'org', scope_id: 'o1', permission_id: 'bam.task.delete', granted: false, is_snapshot: false },
      ],
    });
    const r = resolve(ctx, 'bam.task.delete', { org_id: 'o1' });
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('org_override');
  });

  it('detached membership reads only account_permissions', () => {
    const ctx = makeCtx({
      memberships: [
        { group_id: 'g1', scope_type: 'org', scope_id: 'o1', detached_at: '2026-05-09T00:00:00Z' },
      ],
      group_defaults: new Map([['g1:bam.task.create', true]]),
      account_overrides: [
        { scope_type: 'org', scope_id: 'o1', permission_id: 'bam.task.create', granted: true, is_snapshot: true },
      ],
    });
    const r = resolve(ctx, 'bam.task.create', { org_id: 'o1' });
    expect(r.decision).toBe('allow');
    expect(r.reason).toBe('org_snapshot');
  });

  it('detached membership without override falls through to next scope', () => {
    const ctx = makeCtx({
      memberships: [
        { group_id: 'g1', scope_type: 'org', scope_id: 'o1', detached_at: '2026-05-09T00:00:00Z' },
        { group_id: 'g0', scope_type: 'global', scope_id: null, detached_at: null },
      ],
      group_defaults: new Map([
        ['g1:bam.task.create', true], // ignored — g1 is detached
        ['g0:bam.task.create', true],
      ]),
    });
    const r = resolve(ctx, 'bam.task.create', { org_id: 'o1' });
    expect(r.decision).toBe('allow');
    expect(r.reason).toBe('global_group_default');
  });
});

describe('resolver — implicit deny + missing catalog', () => {
  it('returns implicit_deny when permission exists in catalog but no scope decides', () => {
    const r = resolve(makeCtx(), 'bam.task.create', { org_id: 'o1' });
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('implicit_deny');
  });

  it('returns permission_not_in_catalog for unknown permission ids', () => {
    const r = resolve(makeCtx(), 'totally.fake.permission', { org_id: 'o1' });
    expect(r.decision).toBe('deny');
    expect(r.reason).toBe('permission_not_in_catalog');
  });
});

describe('can() convenience helper', () => {
  it('returns true for allow', () => {
    const ctx = makeCtx({
      subject: { id: 'u1', is_superuser: true, kind: 'human', api_key_scope: null },
    });
    expect(can(ctx, 'bam.task.create', { org_id: 'o1' })).toBe(true);
  });
  it('returns false for deny', () => {
    expect(can(makeCtx(), 'bam.task.create', { org_id: 'o1' })).toBe(false);
  });
});
