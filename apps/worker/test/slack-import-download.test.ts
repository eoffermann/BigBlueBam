import { describe, it, expect, vi } from 'vitest';
import type { Logger } from 'pino';

vi.mock('../src/utils/db.js', () => ({ getDb: vi.fn() }));

import { downloadSlackUrl } from '../src/jobs/slack-import.job.js';

// url_private in a Slack export's files.json is attacker-controlled (the zip
// is user-uploaded). The workspace's Slack bearer token must only ever be
// sent to Slack, and the download must not reach internal addresses.

const logger = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const TOKEN = 'xoxb-workspace-token';

describe('downloadSlackUrl', () => {
  it.each(['https://attacker.example/steal', 'http://files.slack.com/x', 'https://slack.com.attacker.example/x'])(
    'never sends the token to %s',
    async (url) => {
      const fetchImpl = vi.fn(async () => new Response('bytes'));
      expect(await downloadSlackUrl({ slackToken: TOKEN, logger, fetchImpl }, url)).toBeNull();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('drops the token when a Slack URL redirects off Slack', async () => {
    process.env.EGRESS_ALLOW_PRIVATE_HOSTS = 'files.slack.com:443,cdn.attacker.example:443';
    const auth: Array<string | null> = [];
    const fetchImpl = vi.fn(async (_u: string, init: RequestInit) => {
      auth.push(new Headers(init.headers).get('authorization'));
      return auth.length === 1
        ? new Response(null, { status: 302, headers: { location: 'https://cdn.attacker.example/f' } })
        : new Response('bytes');
    });
    try {
      const buf = await downloadSlackUrl(
        { slackToken: TOKEN, logger, fetchImpl: fetchImpl as unknown as typeof fetch },
        'https://files.slack.com/files-pri/T1-F1/download/a.png',
      );
      expect(buf?.toString()).toBe('bytes');
      expect(auth).toEqual([`Bearer ${TOKEN}`, null]);
    } finally {
      delete process.env.EGRESS_ALLOW_PRIVATE_HOSTS;
    }
  });

  it('refuses a Slack URL that redirects into the internal network', async () => {
    process.env.EGRESS_ALLOW_PRIVATE_HOSTS = 'files.slack.com:443';
    const fetchImpl = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }));
    try {
      expect(
        await downloadSlackUrl(
          { slackToken: TOKEN, logger, fetchImpl: fetchImpl as unknown as typeof fetch },
          'https://files.slack.com/files-pri/T1-F1/download/a.png',
        ),
      ).toBeNull();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.EGRESS_ALLOW_PRIVATE_HOSTS;
    }
  });
});
