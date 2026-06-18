import { afterEach, describe, expect, it } from 'vitest';
import {
  clearOrgSmtpConfigCache,
  clearSmtpConfigCache,
  getSmtpConfig,
  getSmtpConfigForOrg,
  isSmtpConfigured,
  resolveSmtpFromSettings,
  resolveSmtpHierarchy,
} from './index.js';

const EMPTY_ENV = {};

afterEach(() => {
  clearSmtpConfigCache();
  clearOrgSmtpConfigCache();
});

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

  it('peels JSON-string wrappers on smtp_host (the Railway 2026-06-11 bug)', () => {
    // PostgreSQL JSONB read can come back as the raw stringified form
    // depending on driver config. The system_settings PUT handler stores
    // every value via JSON.stringify, so a host of "smtp.example.com"
    // becomes the 18-byte string `"smtp.example.com"` on disk. Without
    // peeling that wrapper, nodemailer asks DNS for the literal hostname
    // including the embedded double-quotes: queryA EBADNAME
    // "smtp.example.com". This regressed on Railway and we never want it
    // to come back.
    const r = resolveSmtpFromSettings(
      { smtp_host: '"smtp.example.com"' },
      EMPTY_ENV,
    );
    expect(r?.host).toBe('smtp.example.com');
  });

  it('peels JSON-string wrappers on every text field', () => {
    const r = resolveSmtpFromSettings(
      {
        smtp_host: '"smtp.example.com"',
        smtp_user: '"someuser"',
        smtp_password: '"correct horse battery staple"',
        smtp_from: '"noreply@example.com"',
      },
      EMPTY_ENV,
    );
    expect(r).toMatchObject({
      host: 'smtp.example.com',
      user: 'someuser',
      pass: 'correct horse battery staple',
      from: 'noreply@example.com',
    });
  });

  it('treats empty-string DB values as missing (fall through to env)', () => {
    const r = resolveSmtpFromSettings(
      { smtp_host: '', smtp_user: '' },
      { SMTP_HOST: 'envhost', SMTP_USER: 'envuser' },
    );
    expect(r?.host).toBe('envhost');
    expect(r?.user).toBe('envuser');
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

describe('resolveSmtpHierarchy (org → platform → env)', () => {
  it('uses the org override when the org has its own host', () => {
    const r = resolveSmtpHierarchy(
      { host: 'mail.acme.test', port: 2525, user: 'acme', password: 'secret', from: 'hi@acme.test' },
      { smtp_host: 'platform-relay', smtp_from: 'noreply@platform.test' },
      { SMTP_HOST: 'env-relay' },
    );
    expect(r).toMatchObject({
      host: 'mail.acme.test',
      port: 2525,
      user: 'acme',
      pass: 'secret',
      from: 'hi@acme.test',
      layer: 'org',
    });
  });

  it('falls through to the platform layer when the org has no override', () => {
    const r = resolveSmtpHierarchy(
      null,
      { smtp_host: 'platform-relay', smtp_from: 'noreply@platform.test' },
      EMPTY_ENV,
    );
    expect(r).toMatchObject({ host: 'platform-relay', layer: 'platform' });
  });

  it('treats a blank-host org override as no override', () => {
    const r = resolveSmtpHierarchy(
      { host: '   ', user: 'ignored' },
      { smtp_host: 'platform-relay' },
      EMPTY_ENV,
    );
    expect(r).toMatchObject({ host: 'platform-relay', layer: 'platform' });
  });

  it('reports layer=env when only env vars supply the platform host', () => {
    const r = resolveSmtpHierarchy(null, {}, { SMTP_HOST: 'env-relay' });
    expect(r).toMatchObject({ host: 'env-relay', layer: 'env' });
  });

  it('org host inherits platform from-address and user when org leaves them blank', () => {
    // Realistic: the platform has a full relay (host+user+from); the org
    // only redirects to its own host and inherits the rest.
    const r = resolveSmtpHierarchy(
      { host: 'mail.acme.test' },
      {
        smtp_host: 'platform-relay',
        smtp_from: 'noreply@platform.test',
        smtp_user: 'platformuser',
        smtp_password: 'pw',
      },
      EMPTY_ENV,
    );
    expect(r).toMatchObject({
      host: 'mail.acme.test',
      from: 'noreply@platform.test',
      user: 'platformuser',
      pass: 'pw',
      layer: 'org',
    });
  });

  it('returns null when no layer has a host', () => {
    expect(resolveSmtpHierarchy({ user: 'x' }, {}, EMPTY_ENV)).toBeNull();
  });

  it('peels JSON-string wrappers on org override fields', () => {
    const r = resolveSmtpHierarchy(
      { host: '"mail.acme.test"', port: '2525', secure: 'true' },
      {},
      EMPTY_ENV,
    );
    expect(r).toMatchObject({ host: 'mail.acme.test', port: 2525, secure: true, layer: 'org' });
  });
});

describe('getSmtpConfigForOrg + per-org cache', () => {
  it('caches per org id and re-reads after clear', async () => {
    let orgCalls = 0;
    const loadOrg = async () => {
      orgCalls += 1;
      return { host: 'mail.acme.test' };
    };
    const loadPlatform = async () => ({});
    await getSmtpConfigForOrg('org-1', loadOrg, loadPlatform, EMPTY_ENV);
    await getSmtpConfigForOrg('org-1', loadOrg, loadPlatform, EMPTY_ENV);
    expect(orgCalls).toBe(1);
    clearOrgSmtpConfigCache('org-1');
    await getSmtpConfigForOrg('org-1', loadOrg, loadPlatform, EMPTY_ENV);
    expect(orgCalls).toBe(2);
  });

  it('keeps two orgs isolated', async () => {
    const loadOrg = async (orgId: string) =>
      orgId === 'org-a' ? { host: 'a.relay.test' } : null;
    const loadPlatform = async () => ({ smtp_host: 'platform-relay' });
    const a = await getSmtpConfigForOrg('org-a', loadOrg, loadPlatform, EMPTY_ENV);
    const b = await getSmtpConfigForOrg('org-b', loadOrg, loadPlatform, EMPTY_ENV);
    expect(a).toMatchObject({ host: 'a.relay.test', layer: 'org' });
    expect(b).toMatchObject({ host: 'platform-relay', layer: 'platform' });
  });

  it('falls through to platform/env when the org loader throws', async () => {
    const r = await getSmtpConfigForOrg(
      'org-x',
      async () => {
        throw new Error('db down');
      },
      async () => ({}),
      { SMTP_HOST: 'env-relay' },
    );
    expect(r).toMatchObject({ host: 'env-relay', layer: 'env' });
  });
});
