import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { boolQueryParam, envBool, envFlag, parseEnvBool } from './common.js';
import { listBondDealsQuerySchema } from './bond.js';
import * as shared from '../index.js';

// #251: the one owner of "string flag -> boolean".

describe('boolQueryParam', () => {
  const q = z.object({ flag: boolQueryParam().optional() });
  it("'false' is false, 'true' is true, unset is undefined, anything else is refused", () => {
    expect(q.parse({ flag: 'false' }).flag).toBe(false);
    expect(q.parse({ flag: 'true' }).flag).toBe(true);
    expect(q.parse({ flag: false }).flag).toBe(false);
    expect(q.parse({}).flag).toBeUndefined();
    expect(q.safeParse({ flag: 'yes' }).success).toBe(false);
  });

  it('is still exported from the package root (the Bastion import keeps working)', () => {
    expect(shared.boolQueryParam).toBe(boolQueryParam);
  });
});

describe('envBool', () => {
  it('reads the false spellings as false and the true spellings as true', () => {
    for (const v of ['false', 'FALSE', '0', 'no', 'off', ' false ']) expect(envBool(true).parse(v)).toBe(false);
    for (const v of ['true', 'True', '1', 'yes', 'on']) expect(envBool(false).parse(v)).toBe(true);
  });

  it('falls back to the default when unset or empty', () => {
    expect(envBool(false).parse(undefined)).toBe(false);
    expect(envBool(false).parse('')).toBe(false);
    expect(envBool(true).parse('')).toBe(true);
    expect(envBool().parse('')).toBeUndefined();
  });

  it('refuses an unrecognised value instead of guessing', () => {
    expect(envBool(false).safeParse('maybe').success).toBe(false);
    expect(parseEnvBool('maybe')).toBe('maybe');
  });

  it('BIN_ALLOW_UNSCANNED_ACCESS=false (the .env.example value) is false', () => {
    const schema = z.object({ BIN_ALLOW_UNSCANNED_ACCESS: envBool(false) });
    expect(schema.parse({ BIN_ALLOW_UNSCANNED_ACCESS: 'false' }).BIN_ALLOW_UNSCANNED_ACCESS).toBe(false);
  });
});

describe('envFlag (#302)', () => {
  it('BBB_RLS_ENFORCE=true enforces, the same as 1 (it used to pick BYPASSRLS)', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'on', ' 1 ']) {
      expect(envFlag('BBB_RLS_ENFORCE', { BBB_RLS_ENFORCE: v })).toBe(true);
    }
  });

  it('unset, empty and the false spellings are off', () => {
    expect(envFlag('BBB_RLS_ENFORCE', {})).toBe(false);
    expect(envFlag('BBB_RLS_ENFORCE', { BBB_RLS_ENFORCE: '' })).toBe(false);
    expect(envFlag('BBB_RLS_ENFORCE', { BBB_RLS_ENFORCE: 'off' })).toBe(false);
  });

  it('an unrecognised spelling throws instead of choosing advisory mode', () => {
    expect(() => envFlag('BBB_RLS_ENFORCE', { BBB_RLS_ENFORCE: 'enabled' })).toThrow(/BBB_RLS_ENFORCE/);
  });
});

describe('listBondDealsQuerySchema', () => {
  it('?stale=false does not filter to stale deals', () => {
    expect(listBondDealsQuerySchema.parse({ stale: 'false' }).stale).toBe(false);
    expect(listBondDealsQuerySchema.parse({ stale: 'true' }).stale).toBe(true);
    expect(listBondDealsQuerySchema.parse({}).stale).toBeUndefined();
  });
});
