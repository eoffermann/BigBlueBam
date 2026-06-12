import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';
import type { TurnCertProbe } from './turn-cert-expiry.job.js';

// Contract: probe the TURN-TLS endpoint daily; report LIVEKIT_TURN_CERT_EXPIRING
// inside the 14-day window and LIVEKIT_TURN_UNREACHABLE on handshake failure,
// each deduped per distinct state; stay silent when healthy or unconfigured.
// The TLS probe and the db are injected/mocked — no network, no postgres.

const executeMock = vi.fn(async (_q: unknown): Promise<unknown[]> => []);
vi.mock('../utils/db.js', () => ({
  getDb: () => ({ execute: executeMock }),
}));

const { processTurnCertExpiryJob } = await import('./turn-cert-expiry.job.js');

function fakeLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    level: 'info',
  } as unknown as Logger;
}

function fakeJob(target?: string): Job {
  return { id: 'cert-test', data: { target } } as unknown as Job;
}

const probeReturning = (result: TurnCertProbe) => async () => result;

beforeEach(() => {
  executeMock.mockClear();
  executeMock.mockImplementation(async () => []);
});

describe('processTurnCertExpiryJob', () => {
  it('no-ops when no target is configured (LAN deploys without TURN)', async () => {
    await processTurnCertExpiryJob(
      fakeJob(undefined) as never,
      fakeLogger(),
      probeReturning({ ok: true, daysLeft: 60, serial: 'S', validTo: 'x' }),
    );
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('stays silent while the certificate is comfortably valid', async () => {
    await processTurnCertExpiryJob(
      fakeJob('turn.example.com:34567') as never,
      fakeLogger(),
      probeReturning({ ok: true, daysLeft: 60, serial: 'S', validTo: '2099-01-01' }),
    );
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('reports LIVEKIT_TURN_CERT_EXPIRING inside the 14-day window with renewal steps', async () => {
    await processTurnCertExpiryJob(
      fakeJob('turn.example.com:34567') as never,
      fakeLogger(),
      probeReturning({ ok: true, daysLeft: 9, serial: 'SER1', validTo: '2026-06-21' }),
    );
    expect(executeMock).toHaveBeenCalledTimes(2); // dedupe SELECT + INSERT
    const insert = JSON.stringify(executeMock.mock.calls[1]?.[0]);
    expect(insert).toContain('LIVEKIT_TURN_CERT_EXPIRING');
    expect(insert).toContain('LIVEKIT_TURN_CERT_PEM');
    expect(insert).toContain('expires in 9 day');
  });

  it('reports LIVEKIT_TURN_UNREACHABLE when the TLS handshake fails', async () => {
    await processTurnCertExpiryJob(
      fakeJob('turn.example.com:34567') as never,
      fakeLogger(),
      probeReturning({ ok: false, error: 'ECONNREFUSED' }),
    );
    const insert = JSON.stringify(executeMock.mock.calls[1]?.[0]);
    expect(insert).toContain('LIVEKIT_TURN_UNREACHABLE');
    expect(insert).toContain('ECONNREFUSED');
  });

  it('dedupes a persisting condition (same serial + days-left)', async () => {
    executeMock.mockImplementation(async (q: unknown) => {
      const s = JSON.stringify(q);
      if (s.includes('SELECT')) {
        return [{ payload: { dedupe_key: 'expiring:SER1:9' } }];
      }
      return [];
    });
    await processTurnCertExpiryJob(
      fakeJob('turn.example.com:34567') as never,
      fakeLogger(),
      probeReturning({ ok: true, daysLeft: 9, serial: 'SER1', validTo: '2026-06-21' }),
    );
    const calls = executeMock.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(calls.some((s) => s.includes('INSERT'))).toBe(false);
  });

  it('re-reports as the countdown advances (different days-left = new state)', async () => {
    executeMock.mockImplementation(async (q: unknown) => {
      const s = JSON.stringify(q);
      if (s.includes('SELECT')) {
        return [{ payload: { dedupe_key: 'expiring:SER1:9' } }];
      }
      return [];
    });
    await processTurnCertExpiryJob(
      fakeJob('turn.example.com:34567') as never,
      fakeLogger(),
      probeReturning({ ok: true, daysLeft: 8, serial: 'SER1', validTo: '2026-06-21' }),
    );
    const calls = executeMock.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(calls.some((s) => s.includes('INSERT'))).toBe(true);
  });

  it('skips malformed targets without touching the db', async () => {
    await processTurnCertExpiryJob(
      fakeJob('not-a-target') as never,
      fakeLogger(),
      probeReturning({ ok: true, daysLeft: 1, serial: 'S', validTo: 'x' }),
    );
    expect(executeMock).not.toHaveBeenCalled();
  });
});
