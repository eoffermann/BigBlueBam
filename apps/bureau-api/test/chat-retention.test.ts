import { describe, expect, it, vi } from 'vitest';

// Pins the ephemeral-chat retention contract: 24h default, admin
// extensions clamped to [1h, 168h], retain-forever yields no expiry, and
// room keys are shape-validated before touching Redis/Postgres.

vi.mock('../src/db/index.js', () => ({
  db: {},
  connection: { end: vi.fn() },
}));

const { clampRetentionHours, computeExpiresAt, ROOM_KEY_RE, MAX_RETENTION_HOURS } =
  await import('../src/services/chat.service.js');

describe('clampRetentionHours', () => {
  it('passes values inside the window through (rounded)', () => {
    expect(clampRetentionHours(24)).toBe(24);
    expect(clampRetentionHours(48.4)).toBe(48);
  });
  it('clamps to one week max — the admin ceiling', () => {
    expect(clampRetentionHours(169)).toBe(MAX_RETENTION_HOURS);
    expect(clampRetentionHours(10_000)).toBe(168);
  });
  it('clamps to at least one hour and defaults junk to 24', () => {
    expect(clampRetentionHours(0)).toBe(1);
    expect(clampRetentionHours(-5)).toBe(1);
    expect(clampRetentionHours(Number.NaN)).toBe(24);
  });
});

describe('computeExpiresAt', () => {
  const at = new Date('2026-06-12T12:00:00Z');
  it('defaults to created_at + 24h', () => {
    expect(computeExpiresAt(at, 24, false)?.toISOString()).toBe('2026-06-13T12:00:00.000Z');
  });
  it('honors extensions up to one week', () => {
    expect(computeExpiresAt(at, 168, false)?.toISOString()).toBe('2026-06-19T12:00:00.000Z');
    // Beyond the ceiling clamps rather than trusting the caller.
    expect(computeExpiresAt(at, 500, false)?.toISOString()).toBe('2026-06-19T12:00:00.000Z');
  });
  it('retain-forever means no expiry at all', () => {
    expect(computeExpiresAt(at, 24, true)).toBeNull();
  });
});

describe('ROOM_KEY_RE', () => {
  it('accepts surface ids, url-derived ids, and uuids', () => {
    expect(ROOM_KEY_RE.test('u1234567890abcdef')).toBe(true);
    expect(ROOM_KEY_RE.test('3a7c2c1e-0000-4000-8000-000000000000')).toBe(true);
  });
  it('rejects path tricks and oversized keys', () => {
    expect(ROOM_KEY_RE.test('../etc/passwd')).toBe(false);
    expect(ROOM_KEY_RE.test('a'.repeat(161))).toBe(false);
    expect(ROOM_KEY_RE.test('')).toBe(false);
  });
});
