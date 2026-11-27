import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// ---- hoisted mocks ----
const { mockTx, mockTransaction } = vi.hoisted(() => {
  const mockTx = {
    execute: vi.fn(),
  };
  const mockTransaction = vi.fn(async (cb: (tx: typeof mockTx) => Promise<unknown>) => cb(mockTx));
  return { mockTx, mockTransaction };
});

vi.mock('../src/db/index.js', () => ({
  db: {
    transaction: mockTransaction,
    execute: vi.fn(),
  },
  connection: { end: vi.fn() },
}));

vi.mock('../src/env.js', () => ({
  env: {
    PORT: 4001,
    DATABASE_URL: 'postgres://test:test@localhost/test',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 'a'.repeat(32),
    HELPDESK_URL: 'http://localhost:8080',
    CORS_ORIGIN: 'http://localhost:8080',
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    SESSION_TTL_SECONDS: 604800,
  },
}));

import {
  countTicketsByPhrase,
  PhraseCountError,
  __test__,
} from '../src/services/phrase-count.service.js';

const ORG = '00000000-0000-4000-8000-0000000000aa';

beforeEach(() => {
  mockTx.execute.mockReset();
  mockTransaction.mockClear();
});

describe('countTicketsByPhrase org scoping', () => {
  const since = new Date('2026-04-01T00:00:00Z');
  const until = new Date('2026-04-18T00:00:00Z');

  it('requires an org', async () => {
    await expect(
      countTicketsByPhrase({ orgId: '', phrase: 'login', buckets: 'day', since, until }),
    ).rejects.toThrow(/orgId is required/);
  });

  it("counts only the org's tickets", async () => {
    mockTx.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await countTicketsByPhrase({ orgId: ORG, phrase: 'login', buckets: 'day', since, until });
    const q = new PgDialect().sqlToQuery(mockTx.execute.mock.calls[1]![0] as SQL);
    expect(q.sql).toMatch(/hu\.org_id = \$\d+/);
    expect(q.params).toContain(ORG);
  });
});

describe('phrase-count.service', () => {
  describe('normalizeBucket', () => {
    it('accepts hour, day, week', () => {
      expect(__test__.normalizeBucket('hour')).toBe('hour');
      expect(__test__.normalizeBucket('day')).toBe('day');
      expect(__test__.normalizeBucket('week')).toBe('week');
    });

    it('rejects anything else', () => {
      expect(() => __test__.normalizeBucket('minute' as never)).toThrow(
        PhraseCountError,
      );
      expect(() => __test__.normalizeBucket('' as never)).toThrow(PhraseCountError);
    });
  });

  describe('countTicketsByPhrase input validation', () => {
    const since = new Date('2026-04-01T00:00:00Z');
    const until = new Date('2026-04-18T00:00:00Z');

    it('rejects empty phrase', async () => {
      await expect(
        countTicketsByPhrase({
          orgId: ORG,
          phrase: '',
          buckets: 'day',
          since,
          until,
        }),
      ).rejects.toThrow(/Phrase must be non-empty/);
    });

    it('rejects whitespace-only phrase', async () => {
      await expect(
        countTicketsByPhrase({
          orgId: ORG,
          phrase: '   ',
          buckets: 'day',
          since,
          until,
        }),
      ).rejects.toThrow(/Phrase must be non-empty/);
    });

    it('rejects invalid since', async () => {
      await expect(
        countTicketsByPhrase({
          orgId: ORG,
          phrase: 'login',
          buckets: 'day',
          since: new Date('not-a-date'),
          until,
        }),
      ).rejects.toThrow(/window.since/);
    });

    it('rejects until <= since', async () => {
      await expect(
        countTicketsByPhrase({
          orgId: ORG,
          phrase: 'login',
          buckets: 'day',
          since,
          until: since,
        }),
      ).rejects.toThrow(/window.until must be strictly greater/);
    });

    it('rejects invalid bucket', async () => {
      await expect(
        countTicketsByPhrase({
          orgId: ORG,
          phrase: 'login',
          buckets: 'minute' as never,
          since,
          until,
        }),
      ).rejects.toThrow(/Invalid bucket granularity/);
    });
  });

  describe('countTicketsByPhrase happy path', () => {
    const since = new Date('2026-04-01T00:00:00Z');
    const until = new Date('2026-04-18T00:00:00Z');

    it('returns mapped buckets and total', async () => {
      // Two SET LOCAL + main query; the transaction callback executes
      // SET LOCAL first, then the SELECT whose result we mock.
      mockTx.execute
        .mockResolvedValueOnce([]) // SET LOCAL statement_timeout returns nothing
        .mockResolvedValueOnce([
          { bucket_start: new Date('2026-04-10T00:00:00Z'), count: 3 },
          { bucket_start: new Date('2026-04-11T00:00:00Z'), count: 5 },
        ]);
      const res = await countTicketsByPhrase({
        orgId: ORG,
        phrase: 'login error',
        buckets: 'day',
        since,
        until,
      });
      expect(res.phrase).toBe('login error');
      expect(res.bucket_granularity).toBe('day');
      expect(res.window.since).toBe(since.toISOString());
      expect(res.window.until).toBe(until.toISOString());
      expect(res.buckets).toHaveLength(2);
      expect(res.buckets[0]!.count).toBe(3);
      expect(res.buckets[1]!.count).toBe(5);
      expect(res.total).toBe(8);
      expect(res.approximate).toBe(false);
      expect(res.generated_at).toMatch(/\d{4}-\d{2}-\d{2}T/);
    });

    it('empty result returns zero total and empty buckets', async () => {
      mockTx.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const res = await countTicketsByPhrase({
        orgId: ORG,
        phrase: 'xyz',
        buckets: 'hour',
        since,
        until,
      });
      expect(res.buckets).toEqual([]);
      expect(res.total).toBe(0);
    });

    it('defaults until to now when omitted', async () => {
      mockTx.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const before = Date.now();
      const res = await countTicketsByPhrase({
        orgId: ORG,
        phrase: 'x',
        buckets: 'week',
        since,
      });
      const afterUntil = new Date(res.window.until).getTime();
      expect(afterUntil).toBeGreaterThanOrEqual(before);
    });

    it('applies statement_timeout inside the transaction', async () => {
      mockTx.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      await countTicketsByPhrase({
        orgId: ORG,
        phrase: 'x',
        buckets: 'day',
        since,
        until,
      });
      // First call was SET LOCAL. drizzle's sql tag exposes queryChunks;
      // naive String() returns '[object Object]'. Walk the chunks for the
      // literal text, falling back to JSON so assertion failures are
      // legible.
      const firstCallArg = mockTx.execute.mock.calls[0]![0] as {
        queryChunks?: Array<{ value?: string[] } | string>;
      };
      const chunksText = Array.isArray(firstCallArg?.queryChunks)
        ? firstCallArg.queryChunks
            .map((c) => (typeof c === 'string' ? c : c?.value?.join(' ') ?? ''))
            .join(' ')
        : JSON.stringify(firstCallArg);
      expect(chunksText.toLowerCase()).toContain('statement_timeout');
    });

    it('coerces numeric-string counts from the driver', async () => {
      mockTx.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([
        { bucket_start: '2026-04-10T00:00:00Z', count: '7' },
      ]);
      const res = await countTicketsByPhrase({
        orgId: ORG,
        phrase: 'x',
        buckets: 'day',
        since,
        until,
      });
      expect(res.buckets[0]!.count).toBe(7);
      expect(res.total).toBe(7);
    });
  });
});
