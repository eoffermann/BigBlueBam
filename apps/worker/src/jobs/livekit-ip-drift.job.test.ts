import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';

// The drift job's contract: compare advertised.json's wan against a
// fresh STUN detection; insert exactly one deduped system_errors row
// per distinct drift transition; stay silent on healthy / unknowable /
// LAN-only states. The db and STUN sides are injected/mocked so these
// tests touch no network and no postgres.

const executeMock = vi.fn(async (_q: unknown): Promise<unknown[]> => []);
vi.mock('../utils/db.js', () => ({
  getDb: () => ({ execute: executeMock }),
}));

const { processLivekitIpDriftJob } = await import('./livekit-ip-drift.job.js');

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

let tmpDir: string;
function writeAdvertised(content: unknown): string {
  const p = path.join(tmpDir, 'advertised.json');
  fs.writeFileSync(p, JSON.stringify(content), 'utf8');
  return p;
}
function fakeJob(advertisedPath: string): Job {
  return { id: 'drift-test', data: { advertised_path: advertisedPath } } as unknown as Job;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lk-drift-'));
  executeMock.mockClear();
  executeMock.mockImplementation(async () => []);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('processLivekitIpDriftJob', () => {
  it('does nothing when advertised.json is missing (pre-rollout stacks)', async () => {
    await processLivekitIpDriftJob(
      fakeJob(path.join(tmpDir, 'nope.json')) as never,
      fakeLogger(),
      async () => '203.0.113.9',
    );
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('does nothing for LAN-only deploys (no wan advertised)', async () => {
    const p = writeAdvertised({ lan: '192.168.1.42', wan: null });
    await processLivekitIpDriftJob(fakeJob(p) as never, fakeLogger(), async () => '203.0.113.9');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('does nothing when detection fails this cycle (egress hiccup ≠ drift)', async () => {
    const p = writeAdvertised({ lan: '192.168.1.42', wan: '203.0.113.7' });
    await processLivekitIpDriftJob(fakeJob(p) as never, fakeLogger(), async () => null);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('does nothing when the advertised wan still matches', async () => {
    const p = writeAdvertised({ lan: '192.168.1.42', wan: '203.0.113.7' });
    await processLivekitIpDriftJob(
      fakeJob(p) as never,
      fakeLogger(),
      async () => '203.0.113.7',
    );
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('inserts a LIVEKIT_WAN_IP_DRIFT row with remediation when the address rotated', async () => {
    const p = writeAdvertised({
      lan: '192.168.1.42',
      wan: '203.0.113.7',
      rendered_at: '2026-06-12T00:00:00.000Z',
    });
    await processLivekitIpDriftJob(fakeJob(p) as never, fakeLogger(), async () => '203.0.113.9');
    // First call: dedupe SELECT; second call: INSERT.
    expect(executeMock).toHaveBeenCalledTimes(2);
    const insertQuery = JSON.stringify(executeMock.mock.calls[1]?.[0]);
    expect(insertQuery).toContain('LIVEKIT_WAN_IP_DRIFT');
    expect(insertQuery).toContain('203.0.113.7');
    expect(insertQuery).toContain('203.0.113.9');
    expect(insertQuery).toContain('force-recreate livekit-config livekit');
  });

  it('dedupes: the same drift transition is reported only once', async () => {
    const p = writeAdvertised({ lan: '192.168.1.42', wan: '203.0.113.7' });
    executeMock.mockImplementation(async (q: unknown) => {
      const s = JSON.stringify(q);
      if (s.includes('SELECT')) {
        return [{ payload: { advertised_wan: '203.0.113.7', current_wan: '203.0.113.9' } }];
      }
      return [];
    });
    await processLivekitIpDriftJob(fakeJob(p) as never, fakeLogger(), async () => '203.0.113.9');
    // SELECT happened, INSERT did not.
    const calls = executeMock.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(calls.some((s) => s.includes('SELECT'))).toBe(true);
    expect(calls.some((s) => s.includes('INSERT'))).toBe(false);
  });

  it('re-reports when the drift transitions to a different address', async () => {
    const p = writeAdvertised({ lan: '192.168.1.42', wan: '203.0.113.7' });
    executeMock.mockImplementation(async (q: unknown) => {
      const s = JSON.stringify(q);
      if (s.includes('SELECT')) {
        // Last report was about a DIFFERENT current address.
        return [{ payload: { advertised_wan: '203.0.113.7', current_wan: '198.51.100.1' } }];
      }
      return [];
    });
    await processLivekitIpDriftJob(fakeJob(p) as never, fakeLogger(), async () => '203.0.113.9');
    const calls = executeMock.mock.calls.map((c) => JSON.stringify(c[0]));
    expect(calls.some((s) => s.includes('INSERT'))).toBe(true);
  });
});
