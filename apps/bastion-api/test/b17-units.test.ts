import { describe, expect, it } from 'vitest';
import { isTransientDbError } from '../src/engine/context.js';

/**
 * Review batch 17, units (no database):
 *   #295 a compile slice tells a transient database error from a deterministic one.
 */

describe('isTransientDbError (#295)', () => {
  it('treats deadlocks, serialization failures, timeouts, restarts and dropped connections as transient', () => {
    for (const code of ['40P01', '40001', '55P03', '57014', '57P01', '57P03', '53300', '08006', '08003', 'CONNECTION_ENDED', 'CONNECTION_CLOSED', 'ECONNRESET']) {
      expect(isTransientDbError({ code })).toBe(true);
    }
    expect(isTransientDbError({ cause: { code: '40P01' } })).toBe(true);
  });

  it('treats data and constraint errors, and errors without a code, as deterministic', () => {
    for (const code of ['22P05', '23505', '23502', '42703', 'XX000']) expect(isTransientDbError({ code })).toBe(false);
    expect(isTransientDbError(new Error('boom'))).toBe(false);
    expect(isTransientDbError(null)).toBe(false);
  });
});
