import { describe, it, expect, afterEach } from 'vitest';
import { IcsCalendarProvider } from '../src/services/calendar-providers/ics-provider.js';

// The ICS feed URL is user-supplied and the sync worker re-fetches it
// unattended, so every fetch must go through the egress guard: no internal
// addresses, and no redirect into one. The stack-internal MinIO feed used by
// the GILLIGAN seed is the one operator-allowlisted exception (#247).

const provider = new IcsCalendarProvider();
const fetchFeed = (feedUrl: string) =>
  provider.fetchEvents({ feedUrl } as never, new Date(0), new Date());

describe('ICS feed egress', () => {
  const saved = process.env.EGRESS_ALLOW_PRIVATE_HOSTS;
  afterEach(() => {
    if (saved === undefined) delete process.env.EGRESS_ALLOW_PRIVATE_HOSTS;
    else process.env.EGRESS_ALLOW_PRIVATE_HOSTS = saved;
  });

  it.each(['http://127.0.0.1:1/feed.ics', 'http://169.254.169.254/latest/meta-data/', 'webcal://[::1]/x.ics'])(
    'refuses %s before connecting',
    async (url) => {
      delete process.env.EGRESS_ALLOW_PRIVATE_HOSTS;
      await expect(fetchFeed(url)).rejects.toThrow(/private\/internal|not allowed/i);
    },
  );

  it('lets an allowlisted host:port past the guard', async () => {
    process.env.EGRESS_ALLOW_PRIVATE_HOSTS = '127.0.0.1:1';
    // Port 1 refuses the connection: the error is now the network's, not the guard's.
    await expect(fetchFeed('http://127.0.0.1:1/feed.ics')).rejects.not.toThrow(/private\/internal|not allowed/i);
  });
});
