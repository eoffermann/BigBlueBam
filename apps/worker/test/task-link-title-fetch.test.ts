import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';

vi.mock('../src/utils/db.js', () => ({
  getDb: vi.fn(),
}));

import {
  processTaskLinkTitleFetchJob,
  type TaskLinkTitleFetchJobData,
  __test__,
} from '../src/jobs/task-link-title-fetch.job.js';
import { getDb } from '../src/utils/db.js';

const { checkUrlSync, isBlockedIPv4, isBlockedIPv6, extractTitle, decodeHtmlEntities } = __test__;

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function createMockJob(
  data: Partial<TaskLinkTitleFetchJobData> = {},
): Job<TaskLinkTitleFetchJobData> {
  return {
    id: 'test-job-1',
    data: {
      task_id: '00000000-0000-0000-0000-000000000001',
      link_id: '00000000-0000-0000-0000-000000000002',
      // IP-literal so the processor skips DNS lookup in tests.
      url: 'http://93.184.216.34/page',
      ...data,
    },
    name: 'fetch-title',
  } as unknown as Job<TaskLinkTitleFetchJobData>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── SSRF guard: private-range rejection matrix ────────────────────

describe('isBlockedIPv4', () => {
  it.each([
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['192.168.1.1', true],
    ['127.0.0.1', true],
    ['127.255.255.254', true],
    ['169.254.169.254', true], // cloud metadata
    ['169.254.0.1', true],
    ['0.0.0.0', true],
    // public / edge-of-range addresses stay allowed
    ['8.8.8.8', false],
    ['93.184.216.34', false],
    ['172.15.255.255', false], // just below 172.16/12
    ['172.32.0.0', false], // just above 172.16/12
    ['11.0.0.1', false], // just above 10/8
    ['192.169.0.1', false], // just above 192.168/16
  ])('%s blocked=%s', (ip, blocked) => {
    expect(isBlockedIPv4(ip)).toBe(blocked);
  });
});

describe('isBlockedIPv6', () => {
  it.each([
    ['::1', true], // loopback
    ['fc00::1', true], // unique local fc00::/7
    ['fd12:3456::1', true],
    ['fe80::1', true], // link-local fe80::/10
    ['feb0::1', true],
    ['::ffff:10.0.0.1', true], // v4-mapped private
    ['::ffff:192.168.1.1', true],
    ['::ffff:a00:1', true], // URL-normalized hex form of ::ffff:10.0.0.1
    ['::ffff:a9fe:a9fe', true], // hex form of ::ffff:169.254.169.254
    ['2001:4860:4860::8888', false], // public
    ['fe00::1', false], // outside fe80::/10
    ['::ffff:8.8.8.8', false], // v4-mapped public
  ])('%s blocked=%s', (ip, blocked) => {
    expect(isBlockedIPv6(ip)).toBe(blocked);
  });
});

describe('checkUrlSync', () => {
  it.each([
    'http://example.com/page',
    'https://example.com/page',
    'https://8.8.8.8/page',
    'http://172.32.0.1/page',
  ])('accepts %s', (url) => {
    expect(checkUrlSync(url).safe).toBe(true);
  });

  it.each([
    'not a url',
    'ftp://example.com/file',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://localhost/admin',
    'http://LOCALHOST/admin',
    'http://metadata.google.internal/computeMetadata',
    'http://foo.internal/x',
    'http://127.0.0.1/x',
    'http://10.1.2.3/x',
    'http://172.16.0.1/x',
    'http://192.168.0.10/x',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/x',
    'http://[fc00::1]/x',
    'http://[fe80::1]/x',
    'http://[::ffff:10.0.0.1]/x',
  ])('rejects %s', (url) => {
    expect(checkUrlSync(url).safe).toBe(false);
  });
});

// ── Title extraction ──────────────────────────────────────────────

describe('extractTitle', () => {
  it('extracts a plain <title>', () => {
    expect(extractTitle('<html><head><title>My Page</title></head></html>')).toBe('My Page');
  });

  it('prefers og:title over <title>', () => {
    const html =
      '<head><meta property="og:title" content="OG Title"><title>Tab Title</title></head>';
    expect(extractTitle(html)).toBe('OG Title');
  });

  it('handles content-before-property attribute order', () => {
    const html = '<meta content="Reversed OG" property="og:title">';
    expect(extractTitle(html)).toBe('Reversed OG');
  });

  it('falls back to <title> when og:title is empty', () => {
    const html = '<meta property="og:title" content=""><title>Fallback</title>';
    expect(extractTitle(html)).toBe('Fallback');
  });

  it('decodes HTML entities', () => {
    expect(extractTitle('<title>Q&amp;A &#8212; R&#xE9;sum&#xE9;s &lt;2026&gt;</title>')).toBe(
      'Q&A — Résumés <2026>',
    );
  });

  it('collapses whitespace and trims', () => {
    expect(extractTitle('<title>\n  Spaced \t  Out  \n</title>')).toBe('Spaced Out');
  });

  it('caps titles at 500 chars', () => {
    const long = 'x'.repeat(600);
    expect(extractTitle(`<title>${long}</title>`)).toHaveLength(500);
  });

  it('returns null when no title is present', () => {
    expect(extractTitle('<html><body>nothing here</body></html>')).toBeNull();
  });

  it('returns null for whitespace-only titles', () => {
    expect(extractTitle('<title>   </title>')).toBeNull();
  });

  it('matches <title> with attributes', () => {
    expect(extractTitle('<title data-x="1">Attr Title</title>')).toBe('Attr Title');
  });
});

describe('decodeHtmlEntities', () => {
  it('leaves unknown entities untouched', () => {
    expect(decodeHtmlEntities('a &bogus; b')).toBe('a &bogus; b');
  });
});

// ── Processor ─────────────────────────────────────────────────────

function makeDbWithExecute(rows: unknown[]) {
  const execute = vi.fn().mockResolvedValue(rows);
  vi.mocked(getDb).mockReturnValue({ execute } as unknown as ReturnType<typeof getDb>);
  return execute;
}

describe('processTaskLinkTitleFetchJob', () => {
  it('fetches the page and patches the link title', async () => {
    const execute = makeDbWithExecute([{ id: '00000000-0000-0000-0000-000000000001' }]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response('<html><head><title>Fetched Title</title></head></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
      ) as unknown as typeof fetch;

    await processTaskLinkTitleFetchJob(createMockJob(), mockLogger, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('never touches the db for a private-range URL', async () => {
    const execute = makeDbWithExecute([]);
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    await processTaskLinkTitleFetchJob(
      createMockJob({ url: 'http://169.254.169.254/latest/meta-data' }),
      mockLogger,
      { fetchImpl },
    );

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('refuses to follow a redirect to a private range', async () => {
    const execute = makeDbWithExecute([]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(null, { status: 302, headers: { location: 'http://10.0.0.5/internal' } }),
      ) as unknown as typeof fetch;

    await processTaskLinkTitleFetchJob(createMockJob(), mockLogger, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('follows a safe redirect and uses the final page title', async () => {
    const execute = makeDbWithExecute([{ id: 'task-1' }]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 301, headers: { location: 'http://93.184.216.34/final' } }),
      )
      .mockResolvedValueOnce(
        new Response('<title>Final Title</title>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ) as unknown as typeof fetch;

    await processTaskLinkTitleFetchJob(createMockJob(), mockLogger, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('swallows network failures without throwing', async () => {
    const execute = makeDbWithExecute([]);
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;

    await expect(
      processTaskLinkTitleFetchJob(createMockJob(), mockLogger, { fetchImpl }),
    ).resolves.toBeUndefined();

    expect(execute).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it('skips non-2xx responses', async () => {
    const execute = makeDbWithExecute([]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('nope', { status: 404 })) as unknown as typeof fetch;

    await processTaskLinkTitleFetchJob(createMockJob(), mockLogger, { fetchImpl });

    expect(execute).not.toHaveBeenCalled();
  });

  it('skips non-HTML content types', async () => {
    const execute = makeDbWithExecute([]);
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response('%PDF-1.7', { status: 200, headers: { 'content-type': 'application/pdf' } }),
      ) as unknown as typeof fetch;

    await processTaskLinkTitleFetchJob(createMockJob(), mockLogger, { fetchImpl });

    expect(execute).not.toHaveBeenCalled();
  });

  it('logs and skips when the guard finds no patchable link row', async () => {
    makeDbWithExecute([]); // RETURNING yields nothing — user titled it meanwhile
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response('<title>Late Title</title>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
      ) as unknown as typeof fetch;

    await expect(
      processTaskLinkTitleFetchJob(createMockJob(), mockLogger, { fetchImpl }),
    ).resolves.toBeUndefined();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ link_id: expect.any(String) }),
      expect.stringContaining('already titled'),
    );
  });
});
