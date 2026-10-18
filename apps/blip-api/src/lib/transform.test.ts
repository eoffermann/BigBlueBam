import { describe, expect, it } from 'vitest';
import {
  compileTransform,
  periodWindow,
  pseudonymPeriods,
  type SaltLookup,
  type TransformRule,
} from './transform.js';

const FRNDO_RULES: TransformRule[] = [
  { match: 'payload:user.user_id', action: 'pseudonymize', params: { period: 'month' } },
  { match: 'payload:user.device_unique_identifier', action: 'drop' },
  { match: 'payload:device.device_name', action: 'drop' },
  { match: 'payload:metrics.message', action: 'drop' },
];

const event = () => ({
  report_type: 'exceptions',
  user: { user_id: 'A1B2-install-guid', device_unique_identifier: 'IDFV-1234' },
  device: { device_model: 'iPhone16,1', device_name: "Eddie's iPhone" },
  metrics: { exception: 'HttpException', message: '{"body":"sensitive"}', module: 'Health' },
});

type Ev = {
  user: Record<string, unknown>;
  device: Record<string, unknown>;
  metrics: Record<string, unknown>;
};

const saltsOf =
  (m: Partial<Record<'day' | 'week' | 'month', string>>): SaltLookup =>
  (p) =>
    m[p] ?? null;

describe('pseudonymize transform', () => {
  const t = compileTransform(FRNDO_RULES, 1, 'static-pepper-0000');

  it('drops the account-joinable ids and free text, keeps everything else', () => {
    const out = t.apply(event(), saltsOf({ month: 'salt-oct' })) as Ev;
    expect(out.user.device_unique_identifier).toBeUndefined();
    expect(out.device.device_name).toBeUndefined();
    expect(out.metrics.message).toBeUndefined();
    expect(out.device.device_model).toBe('iPhone16,1');
    expect(out.metrics.exception).toBe('HttpException');
    expect(out.user.user_id).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(out)).not.toContain('A1B2-install-guid');
  });

  it('is stable within a period and changes when the period salt changes', () => {
    const a = (t.apply(event(), saltsOf({ month: 'salt-oct' })) as Ev).user.user_id;
    const b = (t.apply(event(), saltsOf({ month: 'salt-oct' })) as Ev).user.user_id;
    const c = (t.apply(event(), saltsOf({ month: 'salt-nov' })) as Ev).user.user_id;
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('drops the id rather than storing it raw when no salt is available', () => {
    const out = t.apply(event(), saltsOf({})) as Ev;
    expect(out.user.user_id).toBeUndefined();
    const noLookup = t.apply(event()) as Ev;
    expect(noLookup.user.user_id).toBeUndefined();
  });

  it('fails closed on an unknown action', () => {
    const bad = compileTransform(
      [{ match: 'payload:user.user_id', action: 'bogus' as TransformRule['action'] }],
      1,
      'static-pepper-0000',
    );
    expect((bad.apply(event()) as Ev).user.user_id).toBeUndefined();
  });

  it('reports the periods a ruleset needs salts for (default month)', () => {
    expect(pseudonymPeriods(FRNDO_RULES)).toEqual(['month']);
    expect(pseudonymPeriods([{ match: 'x', action: 'pseudonymize' }])).toEqual(['month']);
    expect(pseudonymPeriods([{ match: 'x', action: 'drop' }])).toEqual([]);
  });
});

describe('periodWindow', () => {
  const at = new Date('2026-10-18T13:45:00Z'); // a Sunday

  it('month ends at the first instant of next month (UTC)', () => {
    expect(periodWindow('month', at)).toEqual({
      label: '2026-10',
      endsAt: new Date('2026-11-01T00:00:00Z'),
    });
    expect(periodWindow('month', new Date('2026-12-31T23:59:59Z')).endsAt).toEqual(
      new Date('2027-01-01T00:00:00Z'),
    );
  });

  it('week is ISO (Monday start)', () => {
    expect(periodWindow('week', at)).toEqual({
      label: 'w2026-10-12',
      endsAt: new Date('2026-10-19T00:00:00Z'),
    });
  });

  it('day ends at next UTC midnight', () => {
    expect(periodWindow('day', at)).toEqual({
      label: '2026-10-18',
      endsAt: new Date('2026-10-19T00:00:00Z'),
    });
  });
});
