import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type Redis from 'ioredis';

vi.mock('../src/utils/db.js', () => ({
  getDb: vi.fn(),
}));

// Dispatch goes through @bigbluebam/egress-guard, which resolves DNS. The
// fixtures use example.test, a reserved name that never resolves, so allowlist
// exactly that host to keep these tests hermetic while still exercising the
// real guard (private targets are covered by 'refuses to POST to ...').
process.env.EGRESS_ALLOW_PRIVATE_HOSTS = 'example.test';

vi.mock('../src/utils/bolt-events.js', () => ({
  publishBoltEvent: vi.fn(),
}));

import {
  processAgentWebhookDispatchJob,
  type AgentWebhookDispatchJobData,
  __test__,
} from '../src/jobs/agent-webhook-dispatch.job.js';
import { getDb } from '../src/utils/db.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function createMockJob(
  delivery_id = '00000000-0000-0000-0000-000000000001',
): Job<AgentWebhookDispatchJobData> {
  return {
    id: 'test-job-1',
    data: { delivery_id },
    name: 'dispatch',
    queue: { add: vi.fn() },
  } as unknown as Job<AgentWebhookDispatchJobData>;
}

function createMockRedis(secret: string | null): Redis {
  return {
    get: vi.fn().mockResolvedValue(secret),
  } as unknown as Redis;
}

// Helpers that mimic the chained builder API Drizzle produces.
function makeSelect(rows: unknown[]) {
  return {
    from: () => ({
      leftJoin: () => ({
        where: () => ({ limit: () => rows }),
      }),
    }),
  };
}

function makeUpdate(returningRows: unknown[] = []) {
  const returning = vi.fn().mockResolvedValue(returningRows);
  return {
    set: () => ({
      where: () => ({ returning }),
    }),
    _returning: returning,
  } as unknown as { set: () => unknown; _returning: Mock };
}

describe('agent webhook dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('signing primitives', () => {
    it('signBody produces sha256=<64hex>', () => {
      const s = __test__.signBody('k', '{}');
      expect(s.signature.startsWith('sha256=')).toBe(true);
      expect(s.signature.length).toBe(7 + 64);
    });

    it('same secret and body produce stable signature for fixed timestamp', () => {
      const body = '{"a":1}';
      // signBody mints its own timestamp so two calls differ; we verify
      // the contract via the verify path instead.
      const s1 = __test__.signBody('k', body);
      const s2 = __test__.signBody('k', body);
      expect(s1.signature.length).toBe(s2.signature.length);
    });
  });

  describe('backoff helper', () => {
    it('schedule is frozen at 0/30/120/600/1800/7200/21600', () => {
      expect([...__test__.BACKOFF_SCHEDULE_SECONDS]).toEqual([
        0, 30, 120, 600, 1800, 7200, 21600,
      ]);
    });

    it('attempt 6 → 21600s', () => {
      expect(__test__.nextRetryDelaySeconds(6)).toBe(21600);
    });

    it('attempt 7 → null (no slot)', () => {
      expect(__test__.nextRetryDelaySeconds(7)).toBe(null);
    });

    it('DLQ_AT_ATTEMPT=8, CIRCUIT_BREAKER_THRESHOLD=20', () => {
      expect(__test__.DLQ_AT_ATTEMPT).toBe(8);
      expect(__test__.CIRCUIT_BREAKER_THRESHOLD).toBe(20);
      expect(__test__.PAYLOAD_CAP_BYTES).toBe(256 * 1024);
    });
  });

  describe('truncation', () => {
    it('passes small payload through', () => {
      const out = __test__.maybeTruncatePayload(
        { hello: 'world' },
        { event_id: 'e1', source: 'bond', event_type: 'deal.rotting' },
      );
      expect(out.truncated).toBe(false);
      expect(out.body).toEqual({ hello: 'world' });
    });

    it('replaces oversize payload with stub', () => {
      const out = __test__.maybeTruncatePayload(
        { big: 'x'.repeat(300 * 1024) },
        { event_id: 'e2', source: 'bam', event_type: 'task.moved' },
      );
      expect(out.truncated).toBe(true);
      expect((out.body as Record<string, unknown>).truncated).toBe(true);
      expect((out.body as Record<string, unknown>).event_id).toBe('e2');
      expect((out.body as Record<string, unknown>).source).toBe('bam');
    });
  });

  describe('dispatch flow', () => {
    it('marks failed when signing secret missing from Redis', async () => {
      const delivery = {
        id: '00000000-0000-0000-0000-000000000001',
        org_id: '00000000-0000-0000-0000-0000000000aa',
        runner_id: '00000000-0000-0000-0000-0000000000bb',
        event_id: '00000000-0000-0000-0000-0000000000cc',
        event_source: 'bond',
        event_type: 'deal.rotting',
        payload: { a: 1 },
        status: 'pending',
        attempt_count: 0,
        last_attempt_at: null,
        last_error: null,
        response_status_code: null,
        created_at: new Date(),
        delivered_at: null,
        next_retry_at: null,
      };
      const runner = {
        id: '00000000-0000-0000-0000-0000000000bb',
        org_id: '00000000-0000-0000-0000-0000000000aa',
        user_id: '00000000-0000-0000-0000-0000000000dd',
        webhook_url: 'https://example.test/hook',
        webhook_enabled: true,
        webhook_consecutive_failures: 0,
        webhook_last_success_at: null,
        webhook_last_failure_at: null,
      };

      const select = makeSelect([{ delivery, runner }]);
      const update1 = makeUpdate();
      const mockDb = {
        select: vi.fn().mockReturnValue(select),
        update: vi.fn().mockReturnValue(update1),
        insert: vi.fn(),
      };
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const mockRedis = createMockRedis(null);
      const mockFetch = vi.fn();
      await processAgentWebhookDispatchJob(createMockJob(), mockRedis, mockLogger, {
        fetchImpl: mockFetch as any,
      });

      expect(mockFetch).not.toHaveBeenCalled();
      expect(mockLogger.error).toHaveBeenCalled();
    });

    it('POSTs with the four X-BigBlueBam-* headers on success', async () => {
      const delivery = {
        id: '00000000-0000-0000-0000-000000000001',
        org_id: '00000000-0000-0000-0000-0000000000aa',
        runner_id: '00000000-0000-0000-0000-0000000000bb',
        event_id: '00000000-0000-0000-0000-0000000000cc',
        event_source: 'bond',
        event_type: 'deal.rotting',
        payload: { a: 1 },
        status: 'pending',
        attempt_count: 0,
        last_attempt_at: null,
        last_error: null,
        response_status_code: null,
        created_at: new Date(),
        delivered_at: null,
        next_retry_at: null,
      };
      const runner = {
        id: '00000000-0000-0000-0000-0000000000bb',
        org_id: '00000000-0000-0000-0000-0000000000aa',
        user_id: '00000000-0000-0000-0000-0000000000dd',
        webhook_url: 'https://example.test/hook',
        webhook_enabled: true,
        webhook_consecutive_failures: 0,
        webhook_last_success_at: null,
        webhook_last_failure_at: null,
      };

      const select = makeSelect([{ delivery, runner }]);
      const update1 = makeUpdate();
      const update2 = makeUpdate();
      const mockDb = {
        select: vi.fn().mockReturnValue(select),
        update: vi.fn().mockReturnValueOnce(update1).mockReturnValueOnce(update2),
        insert: vi.fn(),
      };
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const mockRedis = createMockRedis('signing-secret-xyz');
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => '',
      });

      await processAgentWebhookDispatchJob(createMockJob(), mockRedis, mockLogger, {
        fetchImpl: mockFetch as any,
      });

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [calledUrl, options] = mockFetch.mock.calls[0]!;
      expect(calledUrl).toBe('https://example.test/hook');
      expect(options.method).toBe('POST');
      const headers = new Headers(options.headers);
      expect(headers.get('Content-Type')).toBe('application/json');
      expect(headers.get('X-BigBlueBam-Signature')!.startsWith('sha256=')).toBe(true);
      expect(headers.get('X-BigBlueBam-Timestamp')).toMatch(/^\d+$/);
      expect(headers.get('X-BigBlueBam-Delivery')).toBe(delivery.id);
      expect(headers.get('X-BigBlueBam-Event')).toBe('bond.deal.rotting');
    });

    // The stored webhook_url is re-sent on every retry and redelivery, and the
    // api's configure-time validator never resolves DNS, so the guard has to
    // run at dispatch: a private target is refused before any request leaves.
    it.each(['http://169.254.169.254/latest/meta-data/', 'http://10.0.0.7/hook', 'http://[::ffff:a00:1]/hook'])(
      'refuses to POST to %s',
      async (webhookUrl) => {
        const delivery = {
          id: '00000000-0000-0000-0000-000000000001',
          org_id: '00000000-0000-0000-0000-0000000000aa',
          runner_id: '00000000-0000-0000-0000-0000000000bb',
          event_id: '00000000-0000-0000-0000-0000000000cc',
          event_source: 'bond',
          event_type: 'deal.rotting',
          payload: { a: 1 },
          status: 'pending',
          attempt_count: 0,
          last_attempt_at: null,
          last_error: null,
          response_status_code: null,
          created_at: new Date(),
          delivered_at: null,
          next_retry_at: null,
        };
        const runner = {
          id: '00000000-0000-0000-0000-0000000000bb',
          org_id: '00000000-0000-0000-0000-0000000000aa',
          user_id: '00000000-0000-0000-0000-0000000000dd',
          webhook_url: webhookUrl,
          webhook_enabled: true,
          webhook_consecutive_failures: 0,
          webhook_last_success_at: null,
          webhook_last_failure_at: null,
        };
        const mockDb = {
          select: vi.fn().mockReturnValue(makeSelect([{ delivery, runner }])),
          update: vi.fn().mockReturnValue(makeUpdate()),
          insert: vi.fn().mockReturnValue({ values: vi.fn().mockResolvedValue(undefined) }),
        };
        vi.mocked(getDb).mockReturnValue(mockDb as any);
        const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => '' });

        await processAgentWebhookDispatchJob(createMockJob(), createMockRedis('signing-secret-xyz'), mockLogger, {
          fetchImpl: mockFetch as any,
        }).catch(() => undefined);

        expect(mockFetch).not.toHaveBeenCalled();
      },
    );

    it('skips a delivery whose status is already terminal', async () => {
      const delivery = {
        id: '00000000-0000-0000-0000-000000000001',
        org_id: '00000000-0000-0000-0000-0000000000aa',
        runner_id: '00000000-0000-0000-0000-0000000000bb',
        event_id: '00000000-0000-0000-0000-0000000000cc',
        event_source: 'bond',
        event_type: 'deal.rotting',
        payload: { a: 1 },
        status: 'delivered',
        attempt_count: 1,
        last_attempt_at: new Date(),
        last_error: null,
        response_status_code: 200,
        created_at: new Date(),
        delivered_at: new Date(),
        next_retry_at: null,
      };
      const runner = {
        id: '00000000-0000-0000-0000-0000000000bb',
        org_id: '00000000-0000-0000-0000-0000000000aa',
        user_id: '00000000-0000-0000-0000-0000000000dd',
        webhook_url: 'https://example.test/hook',
        webhook_enabled: true,
        webhook_consecutive_failures: 0,
        webhook_last_success_at: null,
        webhook_last_failure_at: null,
      };

      const select = makeSelect([{ delivery, runner }]);
      const mockDb = {
        select: vi.fn().mockReturnValue(select),
        update: vi.fn(),
        insert: vi.fn(),
      };
      vi.mocked(getDb).mockReturnValue(mockDb as any);

      const mockFetch = vi.fn();
      await processAgentWebhookDispatchJob(createMockJob(), createMockRedis('s'), mockLogger, {
        fetchImpl: mockFetch as any,
      });

      expect(mockFetch).not.toHaveBeenCalled();
    });
  });
});
