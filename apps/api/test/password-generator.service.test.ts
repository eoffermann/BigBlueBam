import { describe, expect, it, vi } from 'vitest';

// The service imports db/index, which validates env at module load. Stub
// the env and db modules so the unit tests can exercise pure logic
// without a live Postgres connection.
vi.mock('../src/env.js', () => ({
  env: {
    SESSION_TTL_SECONDS: 604800,
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    NODE_ENV: 'test',
    PORT: 4000,
    HOST: '0.0.0.0',
    SESSION_SECRET: 'a'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    COOKIE_DOMAIN: undefined,
    COOKIE_SECURE: false,
    INTERNAL_SERVICE_SECRET: 'a'.repeat(32),
  },
}));
vi.mock('../src/db/index.js', () => ({ db: { execute: vi.fn() } }));

const {
  DEFAULT_POLICY,
  generatePasswordFromPolicy,
  normalizePolicy,
} = await import('../src/services/password-generator.service.js');
type PasswordPolicy = Awaited<
  ReturnType<typeof import('../src/services/password-generator.service.js')['getPasswordPolicy']>
>;
const { PASSPHRASE_WORDS } = await import('../src/services/password-words.js');

describe('normalizePolicy', () => {
  it('returns DEFAULT_POLICY for non-object input', () => {
    expect(normalizePolicy(null)).toEqual(DEFAULT_POLICY);
    expect(normalizePolicy(undefined)).toEqual(DEFAULT_POLICY);
    expect(normalizePolicy('garbage')).toEqual(DEFAULT_POLICY);
    expect(normalizePolicy(42)).toEqual(DEFAULT_POLICY);
  });

  it('clamps alphanumeric length to [12, 64]', () => {
    expect(normalizePolicy({ alphanumeric: { length: 1 } }).alphanumeric.length).toBe(12);
    expect(normalizePolicy({ alphanumeric: { length: 9999 } }).alphanumeric.length).toBe(64);
    expect(normalizePolicy({ alphanumeric: { length: 24 } }).alphanumeric.length).toBe(24);
  });

  it('clamps passphrase fields', () => {
    const out = normalizePolicy({
      passphrase: { word_count: 1, digit_count: 99, separator: 'longerthan3' },
    });
    expect(out.passphrase.word_count).toBe(3);
    expect(out.passphrase.digit_count).toBe(4);
    expect(out.passphrase.separator).toBe('lon');
  });

  it('rejects unknown modes by keeping default', () => {
    expect(normalizePolicy({ mode: 'morse-code' }).mode).toBe('alphanumeric');
    expect(normalizePolicy({ mode: 'passphrase' }).mode).toBe('passphrase');
  });
});

describe('generatePasswordFromPolicy — alphanumeric', () => {
  it('produces the configured length', () => {
    const policy: PasswordPolicy = {
      ...DEFAULT_POLICY,
      mode: 'alphanumeric',
      alphanumeric: { length: 24 },
    };
    for (let i = 0; i < 50; i++) {
      const p = generatePasswordFromPolicy(policy);
      expect(p).toHaveLength(24);
    }
  });

  it('uses only confusable-safe alphabet chars', () => {
    const out = generatePasswordFromPolicy(DEFAULT_POLICY);
    expect(out).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]+$/);
  });
});

describe('generatePasswordFromPolicy — passphrase', () => {
  const passphrase: PasswordPolicy = {
    ...DEFAULT_POLICY,
    mode: 'passphrase',
    passphrase: {
      word_count: 4,
      separator: '-',
      capitalize_words: true,
      digit_count: 2,
      append_symbol: true,
    },
  };

  it('uses words from the curated list', () => {
    const out = generatePasswordFromPolicy(passphrase);
    // Strip trailing symbol and the dash-digits before splitting words.
    const symbolStripped = out.replace(/[!@#$%^&*?+=]$/, '');
    const noTrailingDigits = symbolStripped.replace(/-\d+$/, '');
    const words = noTrailingDigits.split('-');
    expect(words).toHaveLength(4);
    for (const w of words) {
      const lower = w.toLowerCase();
      expect(PASSPHRASE_WORDS).toContain(lower);
    }
  });

  it('respects capitalize_words=false', () => {
    const out = generatePasswordFromPolicy({
      ...passphrase,
      passphrase: { ...passphrase.passphrase, capitalize_words: false },
    });
    expect(out).toMatch(/^[a-z]/);
  });

  it('respects empty separator', () => {
    const out = generatePasswordFromPolicy({
      ...passphrase,
      passphrase: {
        ...passphrase.passphrase,
        separator: '',
        digit_count: 0,
        append_symbol: false,
      },
    });
    expect(out).not.toMatch(/[^A-Za-z]/);
  });

  it('respects digit_count=0', () => {
    const out = generatePasswordFromPolicy({
      ...passphrase,
      passphrase: { ...passphrase.passphrase, digit_count: 0, append_symbol: false },
    });
    expect(out).not.toMatch(/\d/);
  });

  it('appends a symbol when configured', () => {
    const out = generatePasswordFromPolicy(passphrase);
    expect(out.slice(-1)).toMatch(/[!@#$%^&*?+=]/);
  });
});

describe('PASSPHRASE_WORDS list', () => {
  it('has enough entries for adequate entropy', () => {
    expect(PASSPHRASE_WORDS.length).toBeGreaterThanOrEqual(1000);
  });

  it('every word is lowercase ASCII', () => {
    for (const w of PASSPHRASE_WORDS) {
      expect(w).toMatch(/^[a-z]+$/);
    }
  });
});
