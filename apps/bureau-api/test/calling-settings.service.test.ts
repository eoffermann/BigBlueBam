// Unit tests for the calling kill-switch parse (bureau troubleshooting
// 2026-06-10). The kill switch defaults ON; only an explicit false / 'false'
// disables. This mirrors apps/api's project-calling-settings readBool so a
// JSONB string value can't make the two services disagree on "disabled".

import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/env.js', () => ({
  env: {
    NODE_ENV: 'test',
    SESSION_SECRET: 'x'.repeat(32),
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    REDIS_URL: 'redis://localhost:6379',
    LIVEKIT_API_KEY: 'devkey',
    LIVEKIT_API_SECRET: 'devsecret',
    LIVEKIT_URL: 'ws://localhost:7880',
  },
}));
vi.mock('../src/db/index.js', () => ({
  db: { execute: vi.fn() },
  connection: { end: vi.fn() },
}));

import { parseKillSwitch } from '../src/services/calling-settings.service.js';

describe('parseKillSwitch (calling.global_enabled parity)', () => {
  it('treats a boolean true / false verbatim', () => {
    expect(parseKillSwitch(true)).toBe(true);
    expect(parseKillSwitch(false)).toBe(false);
  });

  it("accepts the string 'true' / 'false' (parity with apps/api readBool)", () => {
    expect(parseKillSwitch('true')).toBe(true);
    expect(parseKillSwitch('false')).toBe(false);
  });

  it('returns null for unset / unrecognized values (caller treats as enabled)', () => {
    expect(parseKillSwitch(undefined)).toBeNull();
    expect(parseKillSwitch(null)).toBeNull();
    expect(parseKillSwitch('')).toBeNull();
    expect(parseKillSwitch('yes')).toBeNull();
    expect(parseKillSwitch(1)).toBeNull();
  });

  it('the enabled rule (parsed !== false) keeps calling ON for everything but explicit false', () => {
    const enabled = (v: unknown) => parseKillSwitch(v) !== false;
    expect(enabled(undefined)).toBe(true); // unset
    expect(enabled(null)).toBe(true);
    expect(enabled(true)).toBe(true);
    expect(enabled('true')).toBe(true); // the bug: was treated as disabled before
    expect(enabled('false')).toBe(false);
    expect(enabled(false)).toBe(false);
  });
});
