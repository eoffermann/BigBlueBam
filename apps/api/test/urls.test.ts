/**
 * Unit tests for the URL builders. These pin the spaBase() normalization
 * that prevents the 2026-06-11 invite-link regression — where a
 * FRONTEND_URL set to the site root (rather than /b3) produced
 * email links that landed on the marketing-site catch-all.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/env.js', () => ({
  env: {
    // The tests reassign env.FRONTEND_URL per-case before calling
    // through; vitest's module mock holds a stable reference.
    FRONTEND_URL: 'http://localhost/b3',
  },
}));

const { spaBase, siteBase } = await import('../src/lib/urls.js');
const { env } = await import('../src/env.js');

describe('spaBase()', () => {
  it('keeps the /b3 suffix when FRONTEND_URL already has it', () => {
    env.FRONTEND_URL = 'https://bigbluebam.com/b3';
    expect(spaBase()).toBe('https://bigbluebam.com/b3');
  });

  it('appends /b3 when FRONTEND_URL is just the site root', () => {
    env.FRONTEND_URL = 'https://bigbluebam.com';
    expect(spaBase()).toBe('https://bigbluebam.com/b3');
  });

  it('strips a trailing slash on either form', () => {
    env.FRONTEND_URL = 'https://bigbluebam.com/';
    expect(spaBase()).toBe('https://bigbluebam.com/b3');
    env.FRONTEND_URL = 'https://bigbluebam.com/b3/';
    expect(spaBase()).toBe('https://bigbluebam.com/b3');
  });

  it('works for localhost defaults', () => {
    env.FRONTEND_URL = 'http://localhost/b3';
    expect(spaBase()).toBe('http://localhost/b3');
    env.FRONTEND_URL = 'http://localhost';
    expect(spaBase()).toBe('http://localhost/b3');
  });
});

describe('siteBase()', () => {
  it('returns the site root regardless of which form FRONTEND_URL is in', () => {
    env.FRONTEND_URL = 'https://bigbluebam.com';
    expect(siteBase()).toBe('https://bigbluebam.com');
    env.FRONTEND_URL = 'https://bigbluebam.com/b3';
    expect(siteBase()).toBe('https://bigbluebam.com');
    env.FRONTEND_URL = 'https://bigbluebam.com/b3/';
    expect(siteBase()).toBe('https://bigbluebam.com');
  });
});
