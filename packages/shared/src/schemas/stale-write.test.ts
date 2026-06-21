import { describe, it, expect } from 'vitest';
import {
  isStaleWrite,
  staleWriteSchema,
  staleWriteError,
  STALE_WRITE_CODE,
} from './stale-write.js';

describe('isStaleWrite', () => {
  const now = new Date('2026-06-21T00:00:00.000Z');

  it('returns false when expected is omitted (guard opted out)', () => {
    expect(isStaleWrite(undefined, now)).toBe(false);
    expect(isStaleWrite(null, now)).toBe(false);
  });

  it('returns false when expected matches the row (down to the ms)', () => {
    expect(isStaleWrite(now.toISOString(), now)).toBe(false);
    // same instant, supplied as a string row value
    expect(isStaleWrite(now.toISOString(), now.toISOString())).toBe(false);
  });

  it('returns true when expected differs from the row', () => {
    const later = new Date(now.getTime() + 1000);
    expect(isStaleWrite(now.toISOString(), later)).toBe(true);
  });

  it('returns false for an unparseable expected (degrade to last-write-wins, never 400)', () => {
    expect(isStaleWrite('not-a-date', now)).toBe(false);
  });

  it('returns false when the row has no updated_at', () => {
    expect(isStaleWrite(now.toISOString(), null)).toBe(false);
    expect(isStaleWrite(now.toISOString(), undefined)).toBe(false);
  });
});

describe('staleWriteSchema', () => {
  it('accepts an absent field', () => {
    expect(staleWriteSchema.parse({})).toEqual({});
  });
  it('accepts a string token and ignores unknown keys', () => {
    const out = staleWriteSchema.parse({ expected_updated_at: 'x', title: 'ignored' });
    expect(out.expected_updated_at).toBe('x');
    expect((out as Record<string, unknown>).title).toBeUndefined();
  });
});

describe('staleWriteError', () => {
  it('builds the 409 envelope with the current updated_at', () => {
    const now = new Date('2026-06-21T00:00:00.000Z');
    const env = staleWriteError('req_1', now);
    expect(env.error.code).toBe(STALE_WRITE_CODE);
    expect(env.error.request_id).toBe('req_1');
    expect(env.current_updated_at).toBe(now.toISOString());
  });
});
