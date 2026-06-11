import { afterEach, describe, expect, it } from 'vitest';
import {
  clearSmtpConfigCache,
  getSmtpConfig,
  isSmtpConfigured,
  resolveSmtpFromSettings,
} from './index.js';

const EMPTY_ENV = {};

afterEach(() => clearSmtpConfigCache());

describe('resolveSmtpFromSettings', () => {
  it('returns null when neither DB nor env has a host', () => {
    expect(resolveSmtpFromSettings({}, EMPTY_ENV)).toBeNull();
  });

  it('uses env-only when DB is empty', () => {
    const r = resolveSmtpFromSettings({}, {
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: 587,
      SMTP_USER: 'me',
      SMTP_PASS: 'pw',
      EMAIL_FROM: 'noreply@example.com',
    });
    expect(r).toMatchObject({
      host: 'smtp.example.com',
      port: 587,
      user: 'me',
      pass: 'pw',
      from: 'noreply@example.com',
      secure: false,
      source: 'env',
    });
  });

  it('uses DB-only when env is empty (the regression scenario)', () => {
    const r = resolveSmtpFromSettings(
      {
        smtp_host: 'mailhog',
        smtp_port: 1025,
        smtp_from: 'noreply@bigbluebam.test',
        smtp_secure: false,
      },
      EMPTY_ENV,
    );
    expect(r).toMatchObject({
      host: 'mailhog',
      port: 1025,
      from: 'noreply@bigbluebam.test',
      secure: false,
      source: 'db',
    });
  });

  it('mixes DB host with env user/pass when only host is in DB', () => {
    const r = resolveSmtpFromSettings(
      { smtp_host: 'smtp.example.com' },
      { SMTP_USER: 'envuser', SMTP_PASS: 'envpass', SMTP_PORT: 587 },
    );
    expect(r).toMatchObject({
      host: 'smtp.example.com',
      user: 'envuser',
      pass: 'envpass',
      source: 'mixed',
    });
  });

  it('parses JSON-string port values (system_settings PUT route stringifies)', () => {
    const r = resolveSmtpFromSettings(
      { smtp_host: 'h', smtp_port: '1025' },
      EMPTY_ENV,
    );
    expect(r?.port).toBe(1025);
  });

  it('parses JSON-string boolean values for smtp_secure', () => {
    const r = resolveSmtpFromSettings(
      { smtp_host: 'h', smtp_secure: 'true' },
      EMPTY_ENV,
    );
    expect(r?.secure).toBe(true);
  });

  it('defaults secure=true when port 465 and no explicit setting', () => {
    const r = resolveSmtpFromSettings(
      { smtp_host: 'h', smtp_port: 465 },
      EMPTY_ENV,
    );
    expect(r?.secure).toBe(true);
  });

  it('classifies source=mixed when both DB and env contribute', () => {
    const r = resolveSmtpFromSettings(
      { smtp_host: 'dbhost' },
      { SMTP_HOST: 'envhost', SMTP_USER: 'envuser' },
    );
    // DB wins for host; both contributed.
    expect(r?.host).toBe('dbhost');
    expect(r?.source).toBe('mixed');
  });
});

describe('getSmtpConfig + cache', () => {
  it('calls the loader once within the cache window', async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return { smtp_host: 'h' };
    };
    await getSmtpConfig(loader, EMPTY_ENV);
    await getSmtpConfig(loader, EMPTY_ENV);
    await getSmtpConfig(loader, EMPTY_ENV);
    expect(calls).toBe(1);
  });

  it('re-reads after clearSmtpConfigCache', async () => {
    let calls = 0;
    const loader = async () => {
      calls += 1;
      return { smtp_host: 'h' };
    };
    await getSmtpConfig(loader, EMPTY_ENV);
    clearSmtpConfigCache();
    await getSmtpConfig(loader, EMPTY_ENV);
    expect(calls).toBe(2);
  });

  it('falls through to env when the loader throws', async () => {
    const loader = async () => {
      throw new Error('db down');
    };
    const r = await getSmtpConfig(loader, { SMTP_HOST: 'envhost' });
    expect(r?.host).toBe('envhost');
  });
});

describe('isSmtpConfigured', () => {
  it('returns true when DB has a host', async () => {
    expect(
      await isSmtpConfigured(async () => ({ smtp_host: 'mailhog' }), EMPTY_ENV),
    ).toBe(true);
  });

  it('returns true when env has a host', async () => {
    expect(
      await isSmtpConfigured(async () => ({}), { SMTP_HOST: 'smtp.example.com' }),
    ).toBe(true);
  });

  it('returns false when neither has a host', async () => {
    expect(await isSmtpConfigured(async () => ({}), EMPTY_ENV)).toBe(false);
  });
});
