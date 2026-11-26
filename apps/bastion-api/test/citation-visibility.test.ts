import { describe, expect, it, vi } from 'vitest';
import { accessTypeOf } from '../src/lib/ref-labels.js';
import { citationVisible, visibleRefs } from '../src/services/decisions.service.js';
import type { Viewer } from '../src/services/types.js';

// #227: every cited ref passes can_access for the reader, including the probe refs to platform
// rows. Owning the control no longer widens what a member may see.

const member: Viewer = {
  id: 'u-gilligan',
  org_id: 'org-1',
  role: 'member',
  is_superuser: false,
  auth_method: 'session',
  impersonator_id: null,
};

describe('accessTypeOf', () => {
  it('maps the bare probe refs onto bam.* visibility types and passes app types through', () => {
    expect(accessTypeOf('github_pr_event')).toBe('bam.github_pr_event');
    expect(accessTypeOf('api_key')).toBe('bam.api_key');
    expect(accessTypeOf('user')).toBe('bam.user');
    expect(accessTypeOf('bam.task')).toBe('bam.task');
    expect(accessTypeOf('mystery')).toBeNull();
  });
});

describe('citationVisible', () => {
  it('asks can_access for a PR event ref with the mapped type and honours a refusal', async () => {
    const canAccess = vi.fn().mockResolvedValue(false);
    const ok = await citationVisible(canAccess, member, { entity_type: 'github_pr_event', entity_id: 'pr-17' });
    expect(ok).toBe(false);
    expect(canAccess).toHaveBeenCalledWith('u-gilligan', 'bam.github_pr_event', 'pr-17');
  });

  it('refuses a ref type with no visibility rule without asking, and fails closed on errors', async () => {
    const canAccess = vi.fn().mockResolvedValue(true);
    expect(await citationVisible(canAccess, member, { entity_type: 'mystery', entity_id: 'x' })).toBe(false);
    expect(canAccess).not.toHaveBeenCalled();
    const broken = vi.fn().mockRejectedValue(new Error('api down'));
    expect(await citationVisible(broken, member, { entity_type: 'api_key', entity_id: 'k1' })).toBe(false);
  });
});

describe('visibleRefs', () => {
  it('keeps order, drops what the reader cannot see, and asks once per distinct ref', async () => {
    const canAccess = vi.fn(async (_u: string, type: string, id: string) => !(type === 'bam.github_pr_event' && id === 'pr-howell'));
    const refs = [
      { entity_type: 'github_pr_event', entity_id: 'pr-radio' },
      { entity_type: 'github_pr_event', entity_id: 'pr-howell' },
      { entity_type: 'user', entity_id: 'u-gilligan' },
      { entity_type: 'github_pr_event', entity_id: 'pr-radio' },
    ];
    const out = await visibleRefs(canAccess, member, refs);
    expect(out.map((r) => r.entity_id)).toEqual(['pr-radio', 'u-gilligan', 'pr-radio']);
    expect(canAccess).toHaveBeenCalledTimes(3);
  });
});
