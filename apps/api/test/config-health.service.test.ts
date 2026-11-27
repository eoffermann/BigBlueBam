import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/env.js', () => ({
  env: { SESSION_SECRET: 'a'.repeat(32), BBB_PERMISSIONS_ENFORCE: 'off' },
}));

import { evaluateConfigHealth } from '../src/services/config-health.service.js';

const healthy = {
  internalServiceSecret: 's'.repeat(48),
  sessionSecret: 'x'.repeat(48),
  permissionsEnforce: 'off',
  rlsEnforce: undefined,
};

const item = (r: ReturnType<typeof evaluateConfigHealth>, key: string) => r.items.find((i) => i.key === key)!;

describe('evaluateConfigHealth', () => {
  it('is critical when INTERNAL_SERVICE_SECRET is unset (every internal route fails closed)', () => {
    const r = evaluateConfigHealth({ ...healthy, internalServiceSecret: undefined });
    expect(r.overall).toBe('critical');
    expect(item(r, 'INTERNAL_SERVICE_SECRET').status).toBe('critical');
  });

  it('warns on a short secret', () => {
    const r = evaluateConfigHealth({ ...healthy, internalServiceSecret: 'short' });
    expect(r.overall).toBe('warning');
    expect(item(r, 'INTERNAL_SERVICE_SECRET').detail).toContain('5 characters');
  });

  it('does not raise the banner for the default advisory posture alone', () => {
    const r = evaluateConfigHealth(healthy);
    expect(r.overall).toBe('ok');
    expect(item(r, 'BBB_PERMISSIONS_ENFORCE').status).toBe('info');
    expect(item(r, 'BBB_RLS_ENFORCE').status).toBe('info');
  });

  it('never includes a secret value in the response', () => {
    const secret = 'S3cr3t-'.repeat(8);
    const r = evaluateConfigHealth({ ...healthy, internalServiceSecret: secret, sessionSecret: secret });
    expect(JSON.stringify(r)).not.toContain(secret);
  });
});
