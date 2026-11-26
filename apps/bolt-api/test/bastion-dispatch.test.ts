import { describe, expect, it, vi } from 'vitest';

// The hook imports env.js; mock it so the forward path runs without the full env surface.
vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    SESSION_SECRET: 'x'.repeat(32),
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    INTERNAL_SERVICE_SECRET: 'i'.repeat(40),
    BASTION_API_INTERNAL_URL: 'http://bastion-api:4024',
  },
}));

import { dispatchToBastion } from '../src/services/bastion-dispatch-hook.js';

/**
 * Issue #206: bolt-api forwards platform proposal.decided to Bastion only for Bastion's own
 * proposals (proposed_action `bastion.*`), not every org's approval traffic.
 */
describe('Bastion dispatch narrows proposal.decided to Bastion proposals (#206)', () => {
  const redis = { sismember: vi.fn().mockResolvedValue(0) } as never;
  const log = { warn: vi.fn() } as never;
  const decided = (action: unknown) => ({
    orgId: '00000000-0000-4000-8000-000000000206',
    source: 'platform',
    eventType: 'proposal.decided',
    payload: { proposal: { id: 'p1', proposed_action: action, decision: 'approve' } },
  });

  it('forwards a bastion.* proposal decision', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    await dispatchToBastion(redis, decided('bastion.fix.confirm_check'), log, fetchImpl as never);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]![0])).toBe('http://bastion-api:4024/v1/internal/events');
  });

  it('does not forward another app\'s proposal decision, or one with no action', async () => {
    const fetchImpl = vi.fn();
    await dispatchToBastion(redis, decided('bursar.draft.send'), log, fetchImpl as never);
    await dispatchToBastion(redis, decided(undefined), log, fetchImpl as never);
    await dispatchToBastion(redis, decided('bastionish.other'), log, fetchImpl as never);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
