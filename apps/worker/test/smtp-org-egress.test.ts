// #321: the worker's org-scoped SMTP send path must apply the same egress
// policy as the api SMTP test route. An org admin who sets
// organizations.settings.smtp.host to an internal address must not get the
// worker to connect to it; the platform/env relay stays unchecked.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EgressBlockedError } from '@bigbluebam/egress-guard';
import { getSmtpConfigForOrg, clearOrgSmtpConfigCache } from '../src/utils/smtp-config.js';
import type { Env } from '../src/env.js';

const env = { SMTP_HOST: 'mailhog', SMTP_PORT: 1025 } as unknown as Env;

/** Fake drizzle: answers the org-override query and the platform settings query. */
function fakeDb(orgSmtp: Record<string, unknown> | null) {
  return {
    execute: vi.fn(async (q: unknown) => {
      const text = JSON.stringify(q);
      if (text.includes('organizations')) return [{ smtp: orgSmtp }];
      return [];
    }),
  };
}

describe('getSmtpConfigForOrg egress guard (#321)', () => {
  beforeEach(() => {
    clearOrgSmtpConfigCache();
    delete process.env.EGRESS_ALLOW_PRIVATE_HOSTS;
  });

  it('refuses an org-supplied private SMTP host', async () => {
    const db = fakeDb({ host: '10.0.0.5', port: 25 });
    await expect(getSmtpConfigForOrg(db, 'org-a', env)).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it('refuses an org-supplied cloud metadata / internal name', async () => {
    const db = fakeDb({ host: 'metadata.google.internal', port: 25 });
    await expect(getSmtpConfigForOrg(db, 'org-b', env)).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it('refuses on every call, not only the first (check runs after the resolver cache)', async () => {
    const db = fakeDb({ host: '127.0.0.1', port: 25 });
    await expect(getSmtpConfigForOrg(db, 'org-c', env)).rejects.toBeInstanceOf(EgressBlockedError);
    await expect(getSmtpConfigForOrg(db, 'org-c', env)).rejects.toBeInstanceOf(EgressBlockedError);
  });

  it('leaves the operator-configured env relay unchecked even when internal', async () => {
    const db = fakeDb(null);
    const cfg = await getSmtpConfigForOrg(db, 'org-d', env);
    expect(cfg?.host).toBe('mailhog');
    expect(cfg?.layer).toBe('env');
  });

  it('honors the EGRESS_ALLOW_PRIVATE_HOSTS dev allowlist for an org host', async () => {
    process.env.EGRESS_ALLOW_PRIVATE_HOSTS = '10.0.0.5:25';
    const db = fakeDb({ host: '10.0.0.5', port: 25 });
    const cfg = await getSmtpConfigForOrg(db, 'org-e', env);
    expect(cfg?.layer).toBe('org');
    expect(cfg?.host).toBe('10.0.0.5');
  });

  it('allows a public literal org host', async () => {
    const db = fakeDb({ host: '8.8.8.8', port: 587 });
    const cfg = await getSmtpConfigForOrg(db, 'org-f', env);
    expect(cfg?.layer).toBe('org');
  });
});
