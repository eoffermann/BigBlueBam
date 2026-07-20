import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { Logger } from 'pino';

// Mock the db module before importing the job
vi.mock('../src/utils/db.js', () => ({
  getDb: vi.fn(),
}));

// Mock the bolt-events module so we can inspect calls
vi.mock('../src/utils/bolt-events.js', () => ({
  publishBoltEvent: vi.fn(),
}));

import {
  processBamTaskOverdueSweepJob,
  type BamTaskOverdueSweepJobData,
} from '../src/jobs/bam-task-overdue-sweep.job.js';
import { getDb } from '../src/utils/db.js';
import { publishBoltEvent } from '../src/utils/bolt-events.js';

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Logger;

function createMockJob(
  data: BamTaskOverdueSweepJobData = {},
  id = 'test-overdue-sweep-1',
): Job<BamTaskOverdueSweepJobData> {
  return { id, data, name: 'sweep' } as unknown as Job<BamTaskOverdueSweepJobData>;
}

function overdueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    org_id: 'org-a',
    human_id: 'GIL-1',
    title: 'Daily Coconut Count',
    project_id: 'proj-1',
    phase_id: 'phase-1',
    priority: 'high',
    due_date: '2026-07-01',
    days_overdue: 5,
    assignee_id: 'user-1',
    assignee_name: 'Gilligan',
    assignee_email: 'gilligan@gilligantravel.example',
    project_name: 'Island Rescue',
    org_name: 'Gilligan Travel Ltd',
    org_slug: 'gilligan-travel-ltd',
    ...overrides,
  };
}

describe('Bam task.overdue sweep job', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns early with no-op when no overdue tasks are found', async () => {
    const mockExecute = vi.fn().mockResolvedValueOnce([]);
    vi.mocked(getDb).mockReturnValue({ execute: mockExecute } as any);

    await processBamTaskOverdueSweepJob(createMockJob(), mockLogger);

    // Only the SELECT ran; no UPDATEs, no emissions.
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(publishBoltEvent).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'test-overdue-sweep-1' }),
      expect.stringContaining('no-op'),
    );
  });

  it('emits task.overdue with trigger_at = due_date and stamps the marker (fires once)', async () => {
    const rows = [overdueRow()];
    const mockExecute = vi
      .fn()
      .mockResolvedValueOnce(rows) // SELECT
      .mockResolvedValueOnce([]); // UPDATE (marker stamp)

    vi.mocked(getDb).mockReturnValue({ execute: mockExecute } as any);
    vi.mocked(publishBoltEvent).mockResolvedValue(undefined);

    await processBamTaskOverdueSweepJob(createMockJob(), mockLogger);

    // 1 SELECT + 1 UPDATE
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(publishBoltEvent).toHaveBeenCalledTimes(1);

    const [eventType, source, payload, orgId, actorId, actorType] = vi.mocked(publishBoltEvent).mock
      .calls[0];
    expect(eventType).toBe('task.overdue');
    expect(source).toBe('bam');
    expect(orgId).toBe('org-a');
    expect(actorId).toBeUndefined();
    expect(actorType).toBe('system');

    const p = payload as any;
    // CRITICAL: trigger_at must equal the task due_date (normalized to ISO) so the live path and
    // the Bulwark state-reconcile converge on the same UTC-day arm key.
    expect(p.trigger_at).toBe(new Date('2026-07-01').toISOString());
    // Nested payload shape the Bolt catalog + bulwark dispatch hook expect.
    expect(p.task.id).toBe('task-1');
    expect(p.task.project_id).toBe('proj-1');
    expect(p.task.due_date).toBe('2026-07-01');
    expect(p.task.days_overdue).toBe(5);
    expect(p.project.id).toBe('proj-1');
    expect(p.org.slug).toBe('gilligan-travel-ltd');

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ alerted: 1, failed: 0, found: 1 }),
      expect.stringContaining('sweep complete'),
    );
  });

  it('idempotency: a second run with the marker already set selects nothing (no re-fire)', async () => {
    // Simulate the DB state AFTER the first run: the guard column is stamped, so the SELECT
    // (which filters overdue_alerted_at IS NULL) returns no rows.
    const mockExecute = vi.fn().mockResolvedValueOnce([]);
    vi.mocked(getDb).mockReturnValue({ execute: mockExecute } as any);

    await processBamTaskOverdueSweepJob(createMockJob(), mockLogger);

    expect(publishBoltEvent).not.toHaveBeenCalled();
    expect(mockExecute).toHaveBeenCalledTimes(1); // SELECT only
  });

  it('re-dated task (marker cleared) re-fires on the next run', async () => {
    // The task.service due_date-change path cleared overdue_alerted_at, so the row is selected
    // again and fires once for its new date.
    const rows = [overdueRow({ due_date: '2026-07-10', days_overdue: 2 })];
    const mockExecute = vi
      .fn()
      .mockResolvedValueOnce(rows) // SELECT
      .mockResolvedValueOnce([]); // UPDATE

    vi.mocked(getDb).mockReturnValue({ execute: mockExecute } as any);
    vi.mocked(publishBoltEvent).mockResolvedValue(undefined);

    await processBamTaskOverdueSweepJob(createMockJob(), mockLogger);

    expect(publishBoltEvent).toHaveBeenCalledTimes(1);
    const p = vi.mocked(publishBoltEvent).mock.calls[0][2] as any;
    expect(p.trigger_at).toBe(new Date('2026-07-10').toISOString());
  });

  it('SELECT excludes done-category, completed, not-yet-due, and already-alerted tasks', async () => {
    // We cannot exercise real SQL in a unit test, but we CAN assert the query text carries every
    // filter, so a refactor that drops one is caught loudly.
    let capturedQuery = '';
    const mockExecute = vi.fn().mockImplementation((query: any) => {
      capturedQuery = JSON.stringify(query);
      return Promise.resolve([]);
    });
    vi.mocked(getDb).mockReturnValue({ execute: mockExecute } as any);

    await processBamTaskOverdueSweepJob(createMockJob(), mockLogger);

    expect(capturedQuery).toContain('overdue_alerted_at');
    expect(capturedQuery).toContain('completed_at');
    expect(capturedQuery).toContain('due_date');
    expect(capturedQuery).toContain('CURRENT_DATE');
    expect(capturedQuery).toContain('category');
    expect(capturedQuery).toContain('done');
  });

  it('continues after one task fails and still processes the rest', async () => {
    const rows = [
      overdueRow({ id: 'task-good', human_id: 'GIL-1' }),
      overdueRow({ id: 'task-bad', human_id: 'GIL-2', org_id: 'org-a' }),
      overdueRow({ id: 'task-good-2', human_id: 'GIL-3', org_id: 'org-b', org_slug: 'org-b-slug' }),
    ];
    const mockExecute = vi
      .fn()
      .mockResolvedValueOnce(rows) // SELECT
      .mockResolvedValueOnce([]) // UPDATE task-good
      .mockRejectedValueOnce(new Error('connection reset')) // UPDATE task-bad fails
      .mockResolvedValueOnce([]); // UPDATE task-good-2

    vi.mocked(getDb).mockReturnValue({ execute: mockExecute } as any);
    vi.mocked(publishBoltEvent).mockResolvedValue(undefined);

    await processBamTaskOverdueSweepJob(createMockJob(), mockLogger);

    // All 3 emitted, all 3 UPDATEs attempted (1 SELECT + 3 UPDATE = 4 execute calls).
    expect(publishBoltEvent).toHaveBeenCalledTimes(3);
    expect(mockExecute).toHaveBeenCalledTimes(4);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: 'task-bad' }),
      expect.stringContaining('failed to process task'),
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ alerted: 2, failed: 1, found: 3 }),
      expect.stringContaining('sweep complete'),
    );
  });

  it('passes organization_id scoping through to the query when provided', async () => {
    let capturedQuery = '';
    const mockExecute = vi.fn().mockImplementation((query: any) => {
      capturedQuery = JSON.stringify(query);
      return Promise.resolve([]);
    });
    vi.mocked(getDb).mockReturnValue({ execute: mockExecute } as any);

    await processBamTaskOverdueSweepJob(
      createMockJob({ organization_id: 'org-scoped-123' }),
      mockLogger,
    );

    expect(capturedQuery).toContain('org-scoped-123');
  });
});
