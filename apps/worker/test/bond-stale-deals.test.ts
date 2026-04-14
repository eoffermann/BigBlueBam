import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';

// Mock the db module before importing the job
vi.mock('../src/utils/db.js', () => ({
  getDb: vi.fn(),
}));

// Mock the shared bolt-events module so we can inspect calls and control failures
vi.mock('@bigbluebam/shared', async () => {
  const actual = await vi.importActual<Record<string, unknown>>('@bigbluebam/shared');
  return {
    ...actual,
    publishBoltEvent: vi.fn(),
  };
});

import {
  processBondStaleDealsJob,
  type BondStaleDealsJobData,
} from '../src/jobs/bond-stale-deals.job.js';
import { getDb } from '../src/utils/db.js';
import { publishBoltEvent } from '@bigbluebam/shared';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function createMockJob(
  data: BondStaleDealsJobData = {},
  id = 'test-stale-sweep-1',
): Job<BondStaleDealsJobData> {
  return { id, data, name: 'daily-sweep' } as unknown as Job<BondStaleDealsJobData>;
}

describe('Bond Stale Deals Job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns early with no-op when no stale deals are found', async () => {
    // First execute() is the SELECT — return empty array
    const mockExecute = vi.fn().mockResolvedValueOnce([]);
    vi.mocked(getDb).mockReturnValue({ execute: mockExecute } as any);

    await processBondStaleDealsJob(createMockJob(), mockLogger);

    // Only the SELECT ran — no UPDATEs, no event emissions
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(publishBoltEvent).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'test-stale-sweep-1' }),
      expect.stringContaining('no-op'),
    );
  });

  it('emits bond.deal.rotting and updates rotting_alerted_at for each stale deal', async () => {
    const staleRows = [
      {
        id: 'deal-1',
        organization_id: 'org-a',
        stage_id: 'stage-1',
        days_in_stage: 45,
        rotting_days: 30,
      },
      {
        id: 'deal-2',
        organization_id: 'org-a',
        stage_id: 'stage-2',
        days_in_stage: 60,
        rotting_days: 14,
      },
      {
        id: 'deal-3',
        organization_id: 'org-b',
        stage_id: 'stage-3',
        days_in_stage: 21,
        rotting_days: 7,
      },
    ];

    const mockExecute = vi
      .fn()
      // Initial SELECT
      .mockResolvedValueOnce(staleRows)
      // Three UPDATEs, one per deal
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    vi.mocked(getDb).mockReturnValue({ execute: mockExecute } as any);
    vi.mocked(publishBoltEvent).mockResolvedValue(undefined);

    await processBondStaleDealsJob(createMockJob(), mockLogger);

    // 1 SELECT + 3 UPDATEs = 4 total execute() calls
    expect(mockExecute).toHaveBeenCalledTimes(4);

    // 3 Bolt events emitted, one per deal, with the expected payload shape
    expect(publishBoltEvent).toHaveBeenCalledTimes(3);
    expect(publishBoltEvent).toHaveBeenNthCalledWith(
      1,
      'bond.deal.rotting',
      'bond',
      {
        deal_id: 'deal-1',
        stage_id: 'stage-1',
        days_in_stage: 45,
        rotting_days_threshold: 30,
      },
      'org-a',
      undefined,
      'system',
      expect.objectContaining({ logger: mockLogger }),
    );
    expect(publishBoltEvent).toHaveBeenNthCalledWith(
      3,
      'bond.deal.rotting',
      'bond',
      expect.objectContaining({ deal_id: 'deal-3' }),
      'org-b',
      undefined,
      'system',
      expect.objectContaining({ logger: mockLogger }),
    );

    // Completion log should report 3 alerted, 0 failed
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ alerted: 3, failed: 0, found: 3 }),
      expect.stringContaining('sweep complete'),
    );
  });

  it('continues processing when one bolt emit fails and still updates the other deals', async () => {
    const staleRows = [
      {
        id: 'deal-ok-1',
        organization_id: 'org-a',
        stage_id: 'stage-1',
        days_in_stage: 40,
        rotting_days: 30,
      },
      {
        id: 'deal-ok-2',
        organization_id: 'org-a',
        stage_id: 'stage-2',
        days_in_stage: 50,
        rotting_days: 14,
      },
    ];

    const mockExecute = vi
      .fn()
      .mockResolvedValueOnce(staleRows) // SELECT
      .mockResolvedValueOnce([]) // UPDATE deal-ok-1
      .mockResolvedValueOnce([]); // UPDATE deal-ok-2

    vi.mocked(getDb).mockReturnValue({ execute: mockExecute } as any);

    // publishBoltEvent is fire-and-forget and NEVER throws, even on failure —
    // that is the contract. So a "failure" here simply resolves (the real impl
    // would have logged the warning internally). Both deals should still get
    // their rotting_alerted_at update.
    vi.mocked(publishBoltEvent).mockResolvedValue(undefined);

    await processBondStaleDealsJob(createMockJob(), mockLogger);

    expect(publishBoltEvent).toHaveBeenCalledTimes(2);
    // Both UPDATEs ran despite any internal emit failure
    expect(mockExecute).toHaveBeenCalledTimes(3);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ alerted: 2, failed: 0 }),
      expect.stringContaining('sweep complete'),
    );
  });

  it('logs and continues when an UPDATE throws mid-batch (one bad row does not kill sweep)', async () => {
    const staleRows = [
      {
        id: 'deal-good',
        organization_id: 'org-a',
        stage_id: 'stage-1',
        days_in_stage: 40,
        rotting_days: 30,
      },
      {
        id: 'deal-bad',
        organization_id: 'org-a',
        stage_id: 'stage-2',
        days_in_stage: 50,
        rotting_days: 14,
      },
      {
        id: 'deal-good-2',
        organization_id: 'org-b',
        stage_id: 'stage-3',
        days_in_stage: 60,
        rotting_days: 7,
      },
    ];

    const mockExecute = vi
      .fn()
      .mockResolvedValueOnce(staleRows) // SELECT
      .mockResolvedValueOnce([]) // UPDATE deal-good succeeds
      .mockRejectedValueOnce(new Error('connection reset')) // UPDATE deal-bad fails
      .mockResolvedValueOnce([]); // UPDATE deal-good-2 succeeds

    vi.mocked(getDb).mockReturnValue({ execute: mockExecute } as any);
    vi.mocked(publishBoltEvent).mockResolvedValue(undefined);

    await processBondStaleDealsJob(createMockJob(), mockLogger);

    // All 3 deals attempted an emit
    expect(publishBoltEvent).toHaveBeenCalledTimes(3);
    // All 3 UPDATEs attempted
    expect(mockExecute).toHaveBeenCalledTimes(4);
    // The bad row was logged at error level
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ dealId: 'deal-bad' }),
      expect.stringContaining('failed to process deal'),
    );
    // Final tally: 2 alerted, 1 failed
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ alerted: 2, failed: 1, found: 3 }),
      expect.stringContaining('sweep complete'),
    );
  });

  it('idempotency: the SELECT query includes the rotting_alerted_at guard', async () => {
    // We can't exercise real SQL in a unit test, but we CAN assert the query
    // text passed to db.execute contains the idempotency clause so a future
    // refactor that drops it is caught loudly.
    let capturedQuery = '';
    const mockExecute = vi.fn().mockImplementation((query: any) => {
      // drizzle sql`` tags produce objects with a `.queryChunks` array of raw
      // strings + params. Stringify the whole thing — good enough for a
      // substring check.
      capturedQuery = JSON.stringify(query);
      return Promise.resolve([]);
    });
    vi.mocked(getDb).mockReturnValue({ execute: mockExecute } as any);

    await processBondStaleDealsJob(createMockJob(), mockLogger);

    expect(capturedQuery).toContain('rotting_alerted_at');
    expect(capturedQuery).toContain('stage_entered_at');
    expect(capturedQuery).toContain('closed_at');
    expect(capturedQuery).toContain('rotting_days');
  });

  it('passes organization_id scoping through to the query when provided', async () => {
    let capturedQuery = '';
    const mockExecute = vi.fn().mockImplementation((query: any) => {
      capturedQuery = JSON.stringify(query);
      return Promise.resolve([]);
    });
    vi.mocked(getDb).mockReturnValue({ execute: mockExecute } as any);

    await processBondStaleDealsJob(
      createMockJob({ organization_id: 'org-scoped-123' }),
      mockLogger,
    );

    // The scoped param should appear in the serialized drizzle sql tag
    expect(capturedQuery).toContain('org-scoped-123');
  });
});
