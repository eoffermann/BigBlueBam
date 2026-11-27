import { describe, it, expect, vi } from 'vitest';
import {
  assertSafeHost,
  assertSafeSmtpTarget,
  checkUrl,
  checkUrlSync,
  EgressBlockedError,
  isBlockedIPv4,
  isBlockedIPv6,
  safeFetch,
} from './index.js';

describe('isBlockedIPv4', () => {
  it('blocks the private and special ranges', () => {
    for (const ip of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '0.0.0.0', '100.64.0.1', '198.18.0.1', '224.0.0.1', '255.255.255.255']) {
      expect(isBlockedIPv4(ip), ip).toBe(true);
    }
  });

  it('blocks cloud metadata addresses', () => {
    expect(isBlockedIPv4('169.254.169.254')).toBe(true);
    expect(isBlockedIPv4('100.100.100.200')).toBe(true);
  });

  it('allows public addresses, including the 172s outside 172.16/12', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.0', '11.0.0.1']) {
      expect(isBlockedIPv4(ip), ip).toBe(false);
    }
  });
});

describe('isBlockedIPv6', () => {
  it('blocks loopback, ULA, link-local, multicast', () => {
    for (const ip of ['::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1']) {
      expect(isBlockedIPv6(ip), ip).toBe(true);
    }
  });

  it('blocks v4-mapped private addresses in dotted and hex form', () => {
    expect(isBlockedIPv6('::ffff:10.0.0.1')).toBe(true);
    // URL.hostname normalizes [::ffff:10.0.0.1] to hex, which a dotted check misses.
    expect(new URL('http://[::ffff:10.0.0.1]/').hostname).toBe('[::ffff:a00:1]');
    expect(isBlockedIPv6('::ffff:a00:1')).toBe(true);
    expect(isBlockedIPv6('::ffff:a9fe:a9fe')).toBe(true);
  });

  it('allows public v6', () => {
    expect(isBlockedIPv6('2606:4700:4700::1111')).toBe(false);
  });
});

describe('checkUrlSync', () => {
  const env = {};
  it('rejects non-http protocols, internal names and private literals', () => {
    for (const u of [
      'file:///etc/passwd',
      'gopher://x/',
      'http://localhost/',
      'http://metadata.google.internal/',
      'http://box.local/',
      'http://127.0.0.1/',
      'http://127.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[::ffff:10.0.0.1]/',
      'not a url',
    ]) {
      expect(checkUrlSync(u, { env }).safe, u).toBe(false);
    }
  });

  it('accepts public URLs and honors extra protocols', () => {
    expect(checkUrlSync('https://example.com/path?q=1', { env }).safe).toBe(true);
    expect(checkUrlSync('webcal://example.com/f.ics', { env }).safe).toBe(false);
    expect(checkUrlSync('webcal://example.com/f.ics', { env, allowedProtocols: ['webcal:'] }).safe).toBe(true);
  });
});

describe('EGRESS_ALLOW_PRIVATE_HOSTS', () => {
  const env = { EGRESS_ALLOW_PRIVATE_HOSTS: 'minio:9000, mailhog' };

  it('is off by default: the stack-internal MinIO feed is refused', async () => {
    expect((await checkUrl('http://minio:9000/gilligan-feeds/rota.ics', { env: {} })).safe).toBe(false);
  });

  it('lets an allowlisted host:port through without resolving it', async () => {
    const res = await checkUrl('http://minio:9000/gilligan-feeds/rota.ics', { env });
    expect(res).toMatchObject({ safe: true, allowlisted: true });
  });

  it('matches the exact port, and a bare host entry matches any port', async () => {
    expect(checkUrlSync('http://minio:9001/', { env: { EGRESS_ALLOW_PRIVATE_HOSTS: 'minio:9000' } }).allowlisted).toBeUndefined();
    expect(checkUrlSync('http://mailhog:1025/', { env }).allowlisted).toBe(true);
    await expect(assertSafeHost('mailhog', 1025, env)).resolves.toBeUndefined();
  });

  it('does not extend to other private hosts', () => {
    expect(checkUrlSync('http://169.254.169.254/', { env }).safe).toBe(false);
    expect(checkUrlSync('http://localhost:9000/', { env }).safe).toBe(false);
  });
});

describe('assertSafeSmtpTarget (#321)', () => {
  it('checks only org-supplied hosts', async () => {
    const env = {} as NodeJS.ProcessEnv;
    await expect(assertSafeSmtpTarget({ host: '10.0.0.5', port: 25, layer: 'org' }, env)).rejects.toBeInstanceOf(
      EgressBlockedError,
    );
    await expect(assertSafeSmtpTarget({ host: '10.0.0.5', port: 25, layer: 'platform' }, env)).resolves.toBeUndefined();
    await expect(assertSafeSmtpTarget({ host: 'mailhog', port: 1025, layer: 'env' }, env)).resolves.toBeUndefined();
  });

  it('honors the allowlist for an org host', async () => {
    const env = { EGRESS_ALLOW_PRIVATE_HOSTS: 'relay.corp:25' } as NodeJS.ProcessEnv;
    await expect(assertSafeSmtpTarget({ host: 'relay.corp', port: 25, layer: 'org' }, env)).resolves.toBeUndefined();
  });
});

describe('safeFetch', () => {
  const env = {};
  const redirectTo = (location: string) => new Response(null, { status: 302, headers: { location } });

  it('revalidates every redirect hop', async () => {
    const fetchImpl = vi.fn(async () => redirectTo('http://169.254.169.254/latest/meta-data/'));
    await expect(safeFetch('http://8.8.8.8/feed', {}, { env, fetchImpl })).rejects.toBeInstanceOf(EgressBlockedError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('strips listed headers when a redirect leaves the origin', async () => {
    const seen: Array<string | null> = [];
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get('authorization'));
      return seen.length === 1 ? redirectTo('http://1.1.1.1/elsewhere') : new Response('ok');
    });
    const res = await safeFetch(
      'http://8.8.8.8/file',
      { headers: { Authorization: 'Bearer xoxb-secret' } },
      { env, fetchImpl: fetchImpl as unknown as typeof fetch, stripHeadersOnCrossOrigin: ['authorization'] },
    );
    expect(await res.text()).toBe('ok');
    expect(seen).toEqual(['Bearer xoxb-secret', null]);
  });

  it('refuses a private URL before fetching', async () => {
    const fetchImpl = vi.fn();
    await expect(safeFetch('http://10.0.0.5/', {}, { env, fetchImpl })).rejects.toThrow(/Private/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
