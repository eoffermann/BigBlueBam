import { describe, it, expect, vi } from 'vitest';
import { createHmac, createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Stand-alone unit tests for AGENTIC_TODO §20 Wave 5 primitives.
//   - HMAC sign/verify round-trip
//   - backoff schedule + DLQ threshold
//   - payload truncation
//   - SSRF URL validation (localhost, 127.x, 169.254.x, 10.x, .internal,
//     production https requirement)
//   - event_filter matcher semantics (*, source:*, source:event)
// ---------------------------------------------------------------------------

// Env stub is required by downstream imports from the service file.
vi.mock('../src/env.js', () => ({
  env: {
    SESSION_TTL_SECONDS: 604800,
    DATABASE_URL: 'postgres://test:test@localhost:5432/test',
    NODE_ENV: 'test',
    PORT: 4000,
    HOST: '0.0.0.0',
    SESSION_SECRET: 'a'.repeat(32),
    REDIS_URL: 'redis://localhost:6379',
    CORS_ORIGIN: 'http://localhost:3000',
    LOG_LEVEL: 'silent',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
  },
}));

vi.mock('../src/db/index.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
  connection: { end: vi.fn() },
}));

import {
  signWebhookBody,
  verifyWebhookSignature,
  nextRetryDelaySeconds,
  truncatePayloadIfOverCap,
  BACKOFF_SCHEDULE_SECONDS,
  DLQ_AT_ATTEMPT,
  CIRCUIT_BREAKER_THRESHOLD,
  PAYLOAD_CAP_BYTES,
} from '../src/lib/webhook-signature.js';
import { checkWebhookUrl } from '../src/services/agent-webhook.service.js';
import { eventMatchesFilter } from '../src/services/agent-webhook.service.js';

describe('webhook HMAC signing', () => {
  it('sign/verify round-trip produces matching sha256= signature', () => {
    const secret = 'test-secret-abc';
    const body = JSON.stringify({ hello: 'world', n: 42 });
    const signed = signWebhookBody(secret, body);

    expect(signed.signature.startsWith('sha256=')).toBe(true);
    expect(signed.signature.length).toBe('sha256='.length + 64);
    expect(signed.body).toBe(body);
    expect(verifyWebhookSignature(secret, body, signed.timestamp, signed.signature)).toBe(true);
  });

  it('matches expected HMAC format explicitly', () => {
    const secret = 'abcdefgh';
    const timestamp = '1700000000';
    const body = '{"a":1}';
    const expected = `sha256=${createHmac('sha256', secret)
      .update(`${timestamp}.${body}`)
      .digest('hex')}`;
    const signed = signWebhookBody(secret, body, timestamp);
    expect(signed.signature).toBe(expected);
  });

  it('rejects tampered body', () => {
    const secret = 'k';
    const body = '{"a":1}';
    const signed = signWebhookBody(secret, body);
    expect(verifyWebhookSignature(secret, '{"a":2}', signed.timestamp, signed.signature)).toBe(
      false,
    );
  });

  it('rejects wrong secret', () => {
    const body = '{"a":1}';
    const signed = signWebhookBody('secret-a', body);
    expect(verifyWebhookSignature('secret-b', body, signed.timestamp, signed.signature)).toBe(
      false,
    );
  });
});

describe('webhook backoff schedule', () => {
  it('first attempt fires with zero delay', () => {
    // By convention attempt_count 0 means "no retries yet". The first
    // fire is driven by the initial enqueue, which uses delay 0.
    expect(BACKOFF_SCHEDULE_SECONDS[0]).toBe(0);
  });

  it('schedule matches 0s/30s/2m/10m/30m/2h/6h', () => {
    expect([...BACKOFF_SCHEDULE_SECONDS]).toEqual([0, 30, 120, 600, 1800, 7200, 21600]);
  });

  it('attempt 1 failed → 30s wait (slot 1)', () => {
    expect(nextRetryDelaySeconds(1)).toBe(30);
  });

  it('attempt 2 failed → 2m wait (slot 2)', () => {
    expect(nextRetryDelaySeconds(2)).toBe(120);
  });

  it('attempt 6 failed → 6h wait (slot 6, last retry slot)', () => {
    expect(nextRetryDelaySeconds(6)).toBe(21600);
  });

  it('attempt 7 failed → no matching slot (undefined schedule), returns null (retries exhausted)', () => {
    expect(nextRetryDelaySeconds(7)).toBe(null);
  });

  it('DLQ_AT_ATTEMPT is 8', () => {
    expect(DLQ_AT_ATTEMPT).toBe(8);
  });

  it('attempt 8 failed → null (dead-letter)', () => {
    expect(nextRetryDelaySeconds(8)).toBe(null);
  });

  it('attempt 0 returns 0 (first-ever try, no delay)', () => {
    expect(nextRetryDelaySeconds(0)).toBe(0);
  });
});

describe('circuit breaker + payload cap constants', () => {
  it('threshold is 20', () => {
    expect(CIRCUIT_BREAKER_THRESHOLD).toBe(20);
  });

  it('payload cap is 256KB', () => {
    expect(PAYLOAD_CAP_BYTES).toBe(256 * 1024);
  });
});

describe('payload truncation', () => {
  it('small payload passes through', () => {
    const payload = { a: 1, b: 'hi' };
    const out = truncatePayloadIfOverCap(payload, {
      event_id: '00000000-0000-0000-0000-000000000001',
      source: 'bond',
      event_type: 'deal.rotting',
    });
    expect(out).toBeNull();
  });

  it('huge payload gets replaced with stub containing truncated:true', () => {
    const huge = { blob: 'x'.repeat(300 * 1024) };
    const out = truncatePayloadIfOverCap(huge, {
      event_id: '00000000-0000-0000-0000-000000000001',
      source: 'bond',
      event_type: 'deal.rotting',
      deep_link: 'https://app/bond/deals/abc',
    });
    expect(out).not.toBeNull();
    expect(out!.truncated).toBe(true);
    expect(out!.event_id).toBe('00000000-0000-0000-0000-000000000001');
    expect(out!.source).toBe('bond');
    expect(out!.event_type).toBe('deal.rotting');
    expect(out!.deep_link).toBe('https://app/bond/deals/abc');
  });
});

describe('webhook URL SSRF guard (registration uses @bigbluebam/egress-guard, #328)', () => {
  it('rejects localhost', async () => {
    expect((await checkWebhookUrl('https://localhost/hook', 'development')).safe).toBe(false);
  });

  it('rejects 127.0.0.1', async () => {
    expect((await checkWebhookUrl('https://127.0.0.1/hook', 'development')).safe).toBe(false);
  });

  it('rejects 169.254.169.254 (cloud metadata)', async () => {
    expect((await checkWebhookUrl('https://169.254.169.254/hook', 'development')).safe).toBe(false);
  });

  it('rejects 10.x in every env, test included (dispatch refuses it too)', async () => {
    expect((await checkWebhookUrl('https://10.0.0.5/hook', 'development')).safe).toBe(false);
    expect((await checkWebhookUrl('http://10.0.0.5:4000/hook', 'test')).safe).toBe(false);
  });

  it('rejects CGNAT and v4-mapped v6, which the old per-app table missed', async () => {
    expect((await checkWebhookUrl('https://100.100.100.200/hook', 'development')).safe).toBe(false);
    expect((await checkWebhookUrl('https://[::ffff:a9fe:a9fe]/hook', 'development')).safe).toBe(false);
  });

  it('allows a stack-internal receiver only through EGRESS_ALLOW_PRIVATE_HOSTS', async () => {
    const env = { EGRESS_ALLOW_PRIVATE_HOSTS: '10.0.0.5:4000' };
    expect((await checkWebhookUrl('http://10.0.0.5:4000/hook', 'test', { env })).safe).toBe(true);
  });

  it('rejects *.internal', async () => {
    expect((await checkWebhookUrl('https://receiver.internal/hook', 'development')).safe).toBe(false);
  });

  it('requires https in production', async () => {
    const r = await checkWebhookUrl('http://93.184.215.14/hook', 'production');
    expect(r.safe).toBe(false);
    expect(r.reason).toMatch(/https/i);
  });

  it('accepts a public https URL in production', async () => {
    expect((await checkWebhookUrl('https://93.184.215.14/hook', 'production')).safe).toBe(true);
  });

  it('rejects file:// and javascript:', async () => {
    expect((await checkWebhookUrl('file:///etc/passwd', 'development')).safe).toBe(false);
    expect((await checkWebhookUrl('javascript:alert(1)', 'development')).safe).toBe(false);
  });

  it('rejects invalid URL', async () => {
    expect((await checkWebhookUrl('not-a-url', 'development')).safe).toBe(false);
  });
});

describe('eventMatchesFilter', () => {
  it('empty filter matches nothing', () => {
    expect(eventMatchesFilter([], 'bond', 'deal.rotting')).toBe(false);
  });

  it('* matches everything', () => {
    expect(eventMatchesFilter(['*'], 'bond', 'deal.rotting')).toBe(true);
    expect(eventMatchesFilter(['*'], 'bam', 'task.moved')).toBe(true);
  });

  it('source:* matches any event from that source', () => {
    expect(eventMatchesFilter(['bond:*'], 'bond', 'deal.rotting')).toBe(true);
    expect(eventMatchesFilter(['bond:*'], 'bond', 'anything')).toBe(true);
    expect(eventMatchesFilter(['bond:*'], 'bam', 'task.moved')).toBe(false);
  });

  it('exact match on source:event_type', () => {
    expect(eventMatchesFilter(['bond:deal.rotting'], 'bond', 'deal.rotting')).toBe(true);
    expect(eventMatchesFilter(['bond:deal.rotting'], 'bond', 'deal.created')).toBe(false);
  });

  it('mixed entries OR together', () => {
    expect(
      eventMatchesFilter(['bond:deal.rotting', 'bam:*'], 'bam', 'task.moved'),
    ).toBe(true);
    expect(
      eventMatchesFilter(['bond:deal.rotting', 'bam:*'], 'bond', 'deal.rotting'),
    ).toBe(true);
    expect(
      eventMatchesFilter(['bond:deal.rotting', 'bam:*'], 'helpdesk', 'ticket.created'),
    ).toBe(false);
  });

  it('entries without colon are ignored (not a legal subscription)', () => {
    expect(eventMatchesFilter(['bond'], 'bond', 'deal.rotting')).toBe(false);
  });
});

describe('argon2 hash vs plaintext (sanity)', () => {
  // This exists to document the contract: we hash with argon2id and
  // never re-reveal. The storage fingerprint differs from the plaintext.
  it('sha256 of hash is not equal to sha256 of plaintext', () => {
    const pt = 'test-plaintext';
    const fakeHash = '$argon2id$v=19$m=65536,t=3,p=4$salt$hash';
    expect(createHash('sha256').update(pt).digest('hex')).not.toBe(
      createHash('sha256').update(fakeHash).digest('hex'),
    );
  });
});
