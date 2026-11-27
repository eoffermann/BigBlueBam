import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------- mocks ----------
const { mockDb } = vi.hoisted(() => {
  const mockDb = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn(),
  };
  return { mockDb };
});

vi.mock('../src/db/index.js', () => ({
  db: mockDb,
  connection: { end: vi.fn() },
}));

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
    LOG_LEVEL: 'info',
    RATE_LIMIT_MAX: 100,
    RATE_LIMIT_WINDOW_MS: 60000,
    UPLOAD_MAX_FILE_SIZE: 10485760,
    UPLOAD_ALLOWED_TYPES: 'image/*',
    COOKIE_SECURE: false,
  },
}));

// ---------- imports ----------
import {
  createProject,
  listProjects,
  getProject,
} from '../src/services/project.service.js';

// ---------- helpers ----------
const now = new Date();
const fakeProject = {
  id: 'proj-1',
  org_id: 'org-1',
  name: 'Test Project',
  slug: 'test-project',
  description: null,
  icon: null,
  color: null,
  task_id_prefix: 'TST',
  task_id_sequence: 0,
  default_sprint_duration_days: 14,
  is_archived: false,
  created_at: now,
  updated_at: now,
};

// ---------- tests ----------
describe('Project Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createProject', () => {
    function setupTransaction(options?: {
      template?: string;
      phaseCount?: number;
      stateCount?: number;
    }) {
      const phaseCount = options?.phaseCount ?? 5;
      const stateCount = options?.stateCount ?? 5;

      mockDb.transaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
        const insertReturning = vi.fn();
        const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
        const txInsert = vi.fn().mockReturnValue({ values: insertValues });

        // Call 1: insert project -> returns project
        insertReturning.mockResolvedValueOnce([fakeProject]);

        // Call 2: insert project membership -> returns membership (no returning chain needed)
        insertReturning.mockResolvedValueOnce([{ project_id: 'proj-1', user_id: 'user-1', role: 'admin' }]);

        if (options?.template !== 'none') {
          // Call 3: insert task states -> returns created states
          const fakeStates = Array.from({ length: stateCount }, (_, i) => ({
            id: `state-${i}`,
            project_id: 'proj-1',
            name: `State ${i}`,
            category: 'todo',
            position: i,
          }));
          insertReturning.mockResolvedValueOnce(fakeStates);

          // Call 4: insert phases -> returns phases
          const fakePhases = Array.from({ length: phaseCount }, (_, i) => ({
            id: `phase-${i}`,
            project_id: 'proj-1',
            name: `Phase ${i}`,
            position: i,
          }));
          insertReturning.mockResolvedValueOnce(fakePhases);
        }

        const tx = { insert: txInsert };
        return cb(tx);
      });

      return { mockTransaction: mockDb.transaction };
    }

    it('inserts project + default phases for kanban_standard template', async () => {
      const { mockTransaction } = setupTransaction({ phaseCount: 5, stateCount: 5 });

      const result = await createProject('org-1', {
        name: 'Test Project',
        task_id_prefix: 'TST',
        template: 'kanban_standard',
      }, 'user-1');

      expect(result.id).toBe('proj-1');
      expect(mockTransaction).toHaveBeenCalled();

      // Verify the transaction callback was invoked, and tx.insert was called 4 times:
      // 1. project, 2. membership, 3. task states, 4. phases
      const txCallback = mockTransaction.mock.calls[0]![0];
      const txInsert = vi.fn();
      const insertReturning = vi.fn()
        .mockResolvedValueOnce([fakeProject])
        .mockResolvedValueOnce([{}])
        .mockResolvedValueOnce(Array.from({ length: 5 }, (_, i) => ({ id: `s-${i}`, name: `S${i}` })))
        .mockResolvedValueOnce(Array.from({ length: 5 }, (_, i) => ({ id: `p-${i}` })));
      const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
      txInsert.mockReturnValue({ values: insertValues });

      await txCallback({ insert: txInsert });

      // project + membership + states + phases = 4 insert calls
      expect(txInsert).toHaveBeenCalledTimes(4);
    });

    it('creates 5 task states for kanban_standard', async () => {
      mockDb.transaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
        const insertReturning = vi.fn();
        const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
        const txInsert = vi.fn().mockReturnValue({ values: insertValues });

        // project
        insertReturning.mockResolvedValueOnce([fakeProject]);
        // membership
        insertReturning.mockResolvedValueOnce([{}]);
        // states: verify 5 states are created
        insertReturning.mockImplementationOnce(() => {
          // This is the states insert - we capture what was passed to values()
          return Promise.resolve(Array.from({ length: 5 }, (_, i) => ({
            id: `state-${i}`,
            name: ['Not Started', 'In Progress', 'Blocked', 'In Review', 'Done'][i],
            category: ['todo', 'active', 'blocked', 'review', 'done'][i],
            position: i,
          })));
        });
        // phases
        insertReturning.mockResolvedValueOnce([]);

        return cb({ insert: txInsert });
      });

      await createProject('org-1', {
        name: 'Test',
        task_id_prefix: 'TST',
        template: 'kanban_standard',
      }, 'user-1');

      // Get the tx.insert mock and check the third call (states)
      const txCb = mockDb.transaction.mock.calls[0]![0];
      const txInsert = vi.fn();
      const statesCapture: unknown[] = [];
      const insertReturning = vi.fn();
      const insertValues = vi.fn().mockImplementation((vals: unknown) => {
        statesCapture.push(vals);
        return { returning: insertReturning };
      });
      txInsert.mockReturnValue({ values: insertValues });
      insertReturning
        .mockResolvedValueOnce([fakeProject])
        .mockResolvedValueOnce([{}])
        .mockResolvedValueOnce(
          Array.from({ length: 5 }, (_, i) => ({ id: `s-${i}`, name: `S${i}` })),
        )
        .mockResolvedValueOnce([]);

      await txCb({ insert: txInsert });

      // The third values() call should have 5 states
      expect(statesCapture[2]).toHaveLength(5);
    });

    it('adds creator as admin member', async () => {
      mockDb.transaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
        const membershipCapture: unknown[] = [];
        const insertReturning = vi.fn();
        const insertValues = vi.fn().mockImplementation((vals: unknown) => {
          membershipCapture.push(vals);
          return { returning: insertReturning };
        });
        const txInsert = vi.fn().mockReturnValue({ values: insertValues });

        insertReturning
          .mockResolvedValueOnce([fakeProject])  // project
          .mockResolvedValueOnce([{}])            // membership
          .mockResolvedValueOnce(Array.from({ length: 5 }, (_, i) => ({ id: `s-${i}`, name: `S${i}` })))
          .mockResolvedValueOnce([]);

        const result = await cb({ insert: txInsert });

        // Second values() call should be the membership with role: 'admin'
        expect(membershipCapture[1]).toEqual(
          expect.objectContaining({
            user_id: 'user-1',
            role: 'admin',
            project_id: 'proj-1',
          }),
        );

        return result;
      });

      await createProject('org-1', {
        name: 'Test',
        task_id_prefix: 'TST',
      }, 'user-1');
    });

    it('handles none template (no phases/states created)', async () => {
      mockDb.transaction.mockImplementation(async (cb: (tx: any) => Promise<unknown>) => {
        const insertReturning = vi.fn();
        const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
        const txInsert = vi.fn().mockReturnValue({ values: insertValues });

        insertReturning
          .mockResolvedValueOnce([fakeProject])  // project
          .mockResolvedValueOnce([{}]);           // membership

        return cb({ insert: txInsert });
      });

      const result = await createProject('org-1', {
        name: 'Empty Project',
        task_id_prefix: 'EMP',
        template: 'none',
      }, 'user-1');

      expect(result.id).toBe('proj-1');

      // Verify tx.insert was only called 2 times (project + membership), no states/phases
      const txCb = mockDb.transaction.mock.calls[0]![0];
      const txInsert = vi.fn();
      const insertReturning = vi.fn()
        .mockResolvedValueOnce([fakeProject])
        .mockResolvedValueOnce([{}]);
      txInsert.mockReturnValue({ values: vi.fn().mockReturnValue({ returning: insertReturning }) });

      await txCb({ insert: txInsert });

      expect(txInsert).toHaveBeenCalledTimes(2);
    });
  });

  describe('listProjects', () => {
    it('only returns projects user is member of', async () => {
      const project1 = { ...fakeProject, id: 'proj-1', name: 'Project A' };
      const membership1 = { project_id: 'proj-1', user_id: 'user-1', role: 'admin', joined_at: now };

      const orderByFn = vi.fn().mockResolvedValue([
        { project: project1, membership: membership1 },
      ]);
      const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
      const innerJoinFn = vi.fn().mockReturnValue({ where: whereFn });
      const fromFn = vi.fn().mockReturnValue({ innerJoin: innerJoinFn });
      mockDb.select.mockReturnValue({ from: fromFn });

      const result = await listProjects('org-1', 'user-1');

      expect(result).toHaveLength(1);
      expect(result[0]).toHaveProperty('membership_role', 'admin');
      expect(result[0]!.id).toBe('proj-1');
      expect(innerJoinFn).toHaveBeenCalled();
    });

    it('returns empty array when user has no projects', async () => {
      const orderByFn = vi.fn().mockResolvedValue([]);
      const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
      const innerJoinFn = vi.fn().mockReturnValue({ where: whereFn });
      const fromFn = vi.fn().mockReturnValue({ innerJoin: innerJoinFn });
      mockDb.select.mockReturnValue({ from: fromFn });

      const result = await listProjects('org-1', 'user-1');

      expect(result).toHaveLength(0);
    });
  });

  describe('getProject', () => {
    it('returns project when found', async () => {
      const limitFn = vi.fn().mockResolvedValue([fakeProject]);
      const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
      const fromFn = vi.fn().mockReturnValue({ where: whereFn });
      mockDb.select.mockReturnValue({ from: fromFn });

      const result = await getProject('proj-1');

      expect(result).not.toBeNull();
      expect(result!.id).toBe('proj-1');
      expect(result!.name).toBe('Test Project');
    });

    it('returns null when project not found', async () => {
      const limitFn = vi.fn().mockResolvedValue([]);
      const whereFn = vi.fn().mockReturnValue({ limit: limitFn });
      const fromFn = vi.fn().mockReturnValue({ where: whereFn });
      mockDb.select.mockReturnValue({ from: fromFn });

      const result = await getProject('nonexistent');

      expect(result).toBeNull();
    });
  });
});
