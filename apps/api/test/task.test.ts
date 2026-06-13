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

vi.mock('../src/services/realtime.service.js', () => ({
  broadcastToProject: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/services/activity.service.js', () => ({
  logActivity: vi.fn().mockResolvedValue(undefined),
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
    PUBLIC_URL: 'http://localhost',
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
  createTask,
  updateTask,
  deleteTask,
  moveTask,
  listTasks,
  getBoardState,
  bulkOperations,
  getTask,
  TaskError,
} from '../src/services/task.service.js';

// ---------- helpers ----------
function chainSelect(rows: unknown[]) {
  const limitFn = vi.fn().mockResolvedValue(rows);
  const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
  const whereFn = vi.fn().mockReturnValue({ limit: limitFn, orderBy: orderByFn });
  const fromFn = vi.fn().mockReturnValue({ where: whereFn, orderBy: orderByFn });
  mockDb.select.mockReturnValue({ from: fromFn });
  return { fromFn, whereFn, limitFn, orderByFn };
}

function chainUpdate(rows: unknown[]) {
  const returningFn = vi.fn().mockResolvedValue(rows);
  const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
  const setFn = vi.fn().mockReturnValue({ where: whereFn });
  mockDb.update.mockReturnValue({ set: setFn });
  return { setFn, whereFn, returningFn };
}

function chainInsert(rows: unknown[]) {
  const returningFn = vi.fn().mockResolvedValue(rows);
  const valuesFn = vi.fn().mockReturnValue({ returning: returningFn });
  mockDb.insert.mockReturnValue({ values: valuesFn });
  return { valuesFn, returningFn };
}

function chainDelete(rows: unknown[]) {
  const returningFn = vi.fn().mockResolvedValue(rows);
  const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
  mockDb.delete.mockReturnValue({ where: whereFn });
  return { whereFn, returningFn };
}

const now = new Date();
const fakeTask = {
  id: 'task-1',
  project_id: 'proj-1',
  human_id: 'TST-1',
  parent_task_id: null,
  title: 'Test Task',
  description: null,
  phase_id: 'phase-1',
  state_id: 'state-1',
  sprint_id: null,
  epic_id: null,
  assignee_id: null,
  reporter_id: 'user-1',
  priority: 'medium',
  story_points: null,
  time_estimate_minutes: null,
  start_date: null,
  due_date: null,
  completed_at: null,
  labels: [],
  custom_fields: {},
  subtask_count: 0,
  position: 1024,
  created_at: now,
  updated_at: now,
};

// ---------- tests ----------
describe('Task Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createTask', () => {
    it('generates human_id from prefix + incremented sequence', async () => {
      // Step 1: update projects to increment task_id_sequence -> returns prefix + seq
      const updateReturning = vi.fn().mockResolvedValue([{ task_id_prefix: 'TST', task_id_sequence: 42 }]);
      const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
      const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
      mockDb.update.mockReturnValueOnce({ set: updateSet });

      // Step 2: select phase for auto_state_on_enter (no state_id provided)
      const phaseLimit = vi.fn().mockResolvedValue([{ id: 'phase-1', auto_state_on_enter: null }]);
      const phaseWhere = vi.fn().mockReturnValue({ limit: phaseLimit });
      const phaseFrom = vi.fn().mockReturnValue({ where: phaseWhere });
      mockDb.select.mockReturnValueOnce({ from: phaseFrom });

      // Step 3: select max position
      const posWhere = vi.fn().mockResolvedValue([{ maxPos: 2048 }]);
      const posFrom = vi.fn().mockReturnValue({ where: posWhere });
      mockDb.select.mockReturnValueOnce({ from: posFrom });

      // Step 4: insert task
      const createdTask = { ...fakeTask, human_id: 'TST-42', position: 3072 };
      const insertReturning = vi.fn().mockResolvedValue([createdTask]);
      const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
      mockDb.insert.mockReturnValue({ values: insertValues });

      const result = await createTask('proj-1', {
        title: 'Test Task',
        phase_id: 'phase-1',
      }, 'user-1');

      expect(result.human_id).toBe('TST-42');
    });

    it('uses auto_state_on_enter from phase if no state_id provided', async () => {
      // update project sequence
      const updateReturning = vi.fn().mockResolvedValue([{ task_id_prefix: 'TST', task_id_sequence: 1 }]);
      const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
      const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
      mockDb.update.mockReturnValueOnce({ set: updateSet });

      // select phase with auto_state_on_enter set
      const phaseLimit = vi.fn().mockResolvedValue([{ id: 'phase-1', auto_state_on_enter: 'state-auto' }]);
      const phaseWhere = vi.fn().mockReturnValue({ limit: phaseLimit });
      const phaseFrom = vi.fn().mockReturnValue({ where: phaseWhere });
      mockDb.select.mockReturnValueOnce({ from: phaseFrom });

      // select max position
      const posWhere = vi.fn().mockResolvedValue([{ maxPos: 0 }]);
      const posFrom = vi.fn().mockReturnValue({ where: posWhere });
      mockDb.select.mockReturnValueOnce({ from: posFrom });

      // insert task -> capture values call
      const insertReturning = vi.fn().mockResolvedValue([{ ...fakeTask, state_id: 'state-auto' }]);
      const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
      mockDb.insert.mockReturnValue({ values: insertValues });

      const result = await createTask('proj-1', {
        title: 'Auto-state task',
        phase_id: 'phase-1',
        // no state_id
      }, 'user-1');

      expect(result.state_id).toBe('state-auto');
      // Verify insert was called with auto state
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ state_id: 'state-auto' }),
      );
    });

    it('calculates next position as max + 1024', async () => {
      // update project seq
      const updateReturning = vi.fn().mockResolvedValue([{ task_id_prefix: 'TST', task_id_sequence: 5 }]);
      const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
      const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
      mockDb.update.mockReturnValueOnce({ set: updateSet });

      // phase lookup (state_id provided, so phase won't be queried for auto state)
      // Actually, the code still queries phase when no state_id. Let's provide state_id.
      // When state_id IS provided, the phase query is skipped.

      // select max position -> maxPos = 5120
      const posWhere = vi.fn().mockResolvedValue([{ maxPos: 5120 }]);
      const posFrom = vi.fn().mockReturnValue({ where: posWhere });
      mockDb.select.mockReturnValueOnce({ from: posFrom });

      // insert task
      const insertReturning = vi.fn().mockResolvedValue([{ ...fakeTask, position: 6144 }]);
      const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
      mockDb.insert.mockReturnValue({ values: insertValues });

      const result = await createTask('proj-1', {
        title: 'Positioned task',
        phase_id: 'phase-1',
        state_id: 'state-1',
      }, 'user-1');

      // The position calculation is max(5120) + 1024 = 6144
      expect(insertValues).toHaveBeenCalledWith(
        expect.objectContaining({ position: 6144 }),
      );
    });

    it('increments parent subtask_count for subtasks', async () => {
      // update project seq
      const updateReturning1 = vi.fn().mockResolvedValue([{ task_id_prefix: 'TST', task_id_sequence: 10 }]);
      const updateWhere1 = vi.fn().mockReturnValue({ returning: updateReturning1 });
      const updateSet1 = vi.fn().mockReturnValue({ where: updateWhere1 });

      // For the parent subtask_count update
      const updateWhere2 = vi.fn().mockResolvedValue(undefined);
      const updateSet2 = vi.fn().mockReturnValue({ where: updateWhere2 });

      mockDb.update
        .mockReturnValueOnce({ set: updateSet1 })  // project seq
        .mockReturnValueOnce({ set: updateSet2 });  // parent subtask_count

      // phase query (no state_id)
      const phaseLimit = vi.fn().mockResolvedValue([{ id: 'phase-1', auto_state_on_enter: null }]);
      const phaseWhere = vi.fn().mockReturnValue({ limit: phaseLimit });
      const phaseFrom = vi.fn().mockReturnValue({ where: phaseWhere });
      mockDb.select.mockReturnValueOnce({ from: phaseFrom });

      // max position
      const posWhere = vi.fn().mockResolvedValue([{ maxPos: 0 }]);
      const posFrom = vi.fn().mockReturnValue({ where: posWhere });
      mockDb.select.mockReturnValueOnce({ from: posFrom });

      // insert task with parent
      const subtask = { ...fakeTask, parent_task_id: 'parent-task-1' };
      const insertReturning = vi.fn().mockResolvedValue([subtask]);
      const insertValues = vi.fn().mockReturnValue({ returning: insertReturning });
      mockDb.insert.mockReturnValue({ values: insertValues });

      await createTask('proj-1', {
        title: 'Subtask',
        phase_id: 'phase-1',
        parent_task_id: 'parent-task-1',
      }, 'user-1');

      // update called twice: once for project sequence, once for parent subtask_count
      expect(mockDb.update).toHaveBeenCalledTimes(2);
    });
  });

  describe('updateTask', () => {
    it('only updates provided fields', async () => {
      const { setFn } = chainUpdate([{ ...fakeTask, title: 'Updated Title' }]);

      const result = await updateTask('task-1', { title: 'Updated Title' });

      expect(result).not.toBeNull();
      expect(result!.title).toBe('Updated Title');
      // set should be called with only title + updated_at
      expect(setFn).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Updated Title' }),
      );
      // Should NOT contain fields that weren't provided
      const setArg = setFn.mock.calls[0][0];
      expect(setArg).not.toHaveProperty('description');
      expect(setArg).not.toHaveProperty('priority');
      expect(setArg).toHaveProperty('updated_at');
    });

    it('returns null for non-existent task', async () => {
      chainUpdate([]);

      const result = await updateTask('nonexistent', { title: 'Nope' });

      expect(result).toBeNull();
    });
  });

  describe('deleteTask', () => {
    it('decrements parent subtask_count when deleting a subtask', async () => {
      // getTask -> select returns task with parent
      const taskWithParent = { ...fakeTask, parent_task_id: 'parent-1' };
      const selectLimit = vi.fn().mockResolvedValue([taskWithParent]);
      const selectWhere = vi.fn().mockReturnValue({ limit: selectLimit });
      const selectFrom = vi.fn().mockReturnValue({ where: selectWhere });
      mockDb.select.mockReturnValue({ from: selectFrom });

      // update parent subtask_count
      const updateWhere = vi.fn().mockResolvedValue(undefined);
      const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
      mockDb.update.mockReturnValue({ set: updateSet });

      // delete task
      const deleteReturning = vi.fn().mockResolvedValue([taskWithParent]);
      const deleteWhere = vi.fn().mockReturnValue({ returning: deleteReturning });
      mockDb.delete.mockReturnValue({ where: deleteWhere });

      const result = await deleteTask('task-1');

      expect(result).not.toBeNull();
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.delete).toHaveBeenCalled();
    });

    it('returns null when task does not exist', async () => {
      const selectLimit = vi.fn().mockResolvedValue([]);
      const selectWhere = vi.fn().mockReturnValue({ limit: selectLimit });
      const selectFrom = vi.fn().mockReturnValue({ where: selectWhere });
      mockDb.select.mockReturnValue({ from: selectFrom });

      const result = await deleteTask('nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('moveTask', () => {
    it('applies auto_state_on_enter from target phase', async () => {
      // select phase
      const phaseLimit = vi.fn().mockResolvedValue([{
        id: 'phase-2',
        auto_state_on_enter: 'state-in-progress',
        is_terminal: false,
      }]);
      const phaseWhere = vi.fn().mockReturnValue({ limit: phaseLimit });
      const phaseFrom = vi.fn().mockReturnValue({ where: phaseWhere });
      mockDb.select.mockReturnValue({ from: phaseFrom });

      // update task
      const updateReturning = vi.fn().mockResolvedValue([{
        ...fakeTask,
        phase_id: 'phase-2',
        state_id: 'state-in-progress',
        position: 500,
      }]);
      const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
      const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
      mockDb.update.mockReturnValue({ set: updateSet });

      const result = await moveTask('task-1', { phase_id: 'phase-2', position: 500 });

      expect(result).not.toBeNull();
      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ state_id: 'state-in-progress' }),
      );
    });

    it('sets completed_at when moving to terminal phase', async () => {
      // Select order inside moveTask:
      //   1. getTask(taskId) → uses .limit() → returns the existing task row
      //   2. phases lookup    → uses .limit() → returns the target phase row
      //   3. tasks WHERE parent_task_id = …  → awaits .where() directly
      //   4. task_parent_links WHERE …       → awaits .where() directly
      // Calls 3 and 4 are the B3 Frndo Launch done-gate's collectChildTaskIds.
      // No children exist here so both return [], which lets the gate pass.

      const getTaskLimit = vi.fn().mockResolvedValue([fakeTask]);
      const getTaskWhere = vi.fn().mockReturnValue({ limit: getTaskLimit });
      const getTaskFrom = vi.fn().mockReturnValue({ where: getTaskWhere });

      const phaseLimit = vi.fn().mockResolvedValue([{
        id: 'phase-done',
        auto_state_on_enter: 'state-done',
        is_terminal: true,
      }]);
      const phaseWhere = vi.fn().mockReturnValue({ limit: phaseLimit });
      const phaseFrom = vi.fn().mockReturnValue({ where: phaseWhere });

      const childrenWhere = vi.fn().mockResolvedValue([]);
      const childrenFrom = vi.fn().mockReturnValue({ where: childrenWhere });

      mockDb.select
        .mockReturnValueOnce({ from: getTaskFrom })
        .mockReturnValueOnce({ from: phaseFrom })
        .mockReturnValueOnce({ from: childrenFrom })
        .mockReturnValueOnce({ from: childrenFrom });

      // update task
      const updateReturning = vi.fn().mockResolvedValue([{
        ...fakeTask,
        phase_id: 'phase-done',
        completed_at: now,
      }]);
      const updateWhere = vi.fn().mockReturnValue({ returning: updateReturning });
      const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
      mockDb.update.mockReturnValue({ set: updateSet });

      await moveTask('task-1', { phase_id: 'phase-done', position: 100 });

      expect(updateSet).toHaveBeenCalledWith(
        expect.objectContaining({ completed_at: expect.any(Date) }),
      );
    });
  });

  describe('listTasks', () => {
    it('applies sprint_id filter', async () => {
      const limitFn = vi.fn().mockResolvedValue([]);
      const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
      const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
      const fromFn = vi.fn().mockReturnValue({ where: whereFn });
      mockDb.select.mockReturnValue({ from: fromFn });

      const result = await listTasks('proj-1', { sprint_id: 'sprint-1' });

      expect(result.data).toEqual([]);
      expect(result.meta.has_more).toBe(false);
      // The where function was called (we trust the ORM applies the filter)
      expect(whereFn).toHaveBeenCalled();
    });

    it('applies search filter (ilike on title)', async () => {
      const limitFn = vi.fn().mockResolvedValue([fakeTask]);
      const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
      const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
      const fromFn = vi.fn().mockReturnValue({ where: whereFn });
      mockDb.select.mockReturnValue({ from: fromFn });

      const result = await listTasks('proj-1', { search: 'Test' });

      expect(result.data).toHaveLength(1);
      expect(whereFn).toHaveBeenCalled();
    });

    it('implements cursor-based pagination', async () => {
      // Return limit+1 items to indicate hasMore
      const items = Array.from({ length: 4 }, (_, i) => ({
        ...fakeTask,
        id: `task-${i}`,
        created_at: new Date(2025, 0, i + 1),
      }));
      const limitFn = vi.fn().mockResolvedValue(items);
      const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
      const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
      const fromFn = vi.fn().mockReturnValue({ where: whereFn });
      mockDb.select.mockReturnValue({ from: fromFn });

      const result = await listTasks('proj-1', { limit: 3 });

      // 4 returned but limit is 3, so data has 3 and has_more is true
      expect(result.data).toHaveLength(3);
      expect(result.meta.has_more).toBe(true);
      expect(result.meta.next_cursor).toBeDefined();
      expect(result.meta.next_cursor).toBe(items[2]!.created_at.toISOString());
    });

    it('returns has_more=false when fewer items than limit', async () => {
      const limitFn = vi.fn().mockResolvedValue([fakeTask]);
      const orderByFn = vi.fn().mockReturnValue({ limit: limitFn });
      const whereFn = vi.fn().mockReturnValue({ orderBy: orderByFn });
      const fromFn = vi.fn().mockReturnValue({ where: whereFn });
      mockDb.select.mockReturnValue({ from: fromFn });

      const result = await listTasks('proj-1', { limit: 50 });

      expect(result.meta.has_more).toBe(false);
      expect(result.meta.next_cursor).toBeNull();
    });
  });

  describe('getBoardState', () => {
    it('returns phases with grouped tasks in position order', async () => {
      const phase1 = { id: 'phase-1', name: 'To Do', position: 0, project_id: 'proj-1' };
      const phase2 = { id: 'phase-2', name: 'Done', position: 1, project_id: 'proj-1' };
      const task1 = { ...fakeTask, phase_id: 'phase-1', position: 100 };
      const task2 = { ...fakeTask, id: 'task-2', phase_id: 'phase-1', position: 200 };
      const task3 = { ...fakeTask, id: 'task-3', phase_id: 'phase-2', position: 100 };

      // First select: phases
      const phasesOrderBy = vi.fn().mockResolvedValue([phase1, phase2]);
      const phasesWhere = vi.fn().mockReturnValue({ orderBy: phasesOrderBy });
      const phasesFrom = vi.fn().mockReturnValue({ where: phasesWhere });

      // Second select: tasks
      const tasksOrderBy = vi.fn().mockResolvedValue([task1, task2, task3]);
      const tasksWhere = vi.fn().mockReturnValue({ orderBy: tasksOrderBy });
      const tasksFrom = vi.fn().mockReturnValue({ where: tasksWhere });

      // Third select: parent enrichment (task_parent_links ⋈ tasks).
      // No links and no legacy parent_task_id on the fixtures → empty.
      const linksWhere = vi.fn().mockResolvedValue([]);
      const linksInnerJoin = vi.fn().mockReturnValue({ where: linksWhere });
      const linksFrom = vi.fn().mockReturnValue({ innerJoin: linksInnerJoin });

      mockDb.select
        .mockReturnValueOnce({ from: phasesFrom })
        .mockReturnValueOnce({ from: tasksFrom })
        .mockReturnValueOnce({ from: linksFrom });

      const result = await getBoardState('proj-1');

      expect(result).toHaveLength(2);
      expect(result[0]!.tasks).toHaveLength(2);
      expect(result[1]!.tasks).toHaveLength(1);
      expect(result[0]!.name).toBe('To Do');
      expect(result[1]!.name).toBe('Done');
      // Every board task now carries its parents array (empty here).
      expect(result[0]!.tasks[0]!.parents).toEqual([]);
    });
  });

  describe('bulkOperations', () => {
    it('processes multiple tasks and reports per-task results', async () => {
      // Each updateTask call needs update mock
      const returningFn = vi.fn()
        .mockResolvedValueOnce([{ ...fakeTask, id: 'task-a', title: 'Bulk Updated' }])
        .mockResolvedValueOnce([{ ...fakeTask, id: 'task-b', title: 'Bulk Updated' }]);
      const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
      const setFn = vi.fn().mockReturnValue({ where: whereFn });
      mockDb.update.mockReturnValue({ set: setFn });

      const results = await bulkOperations({
        task_ids: ['task-a', 'task-b'],
        operation: 'update',
        fields: { title: 'Bulk Updated' },
      }, 'user-1');

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ task_id: 'task-a', success: true });
      expect(results[1]).toEqual({ task_id: 'task-b', success: true });
    });

    it('reports errors per-task without failing the whole batch', async () => {
      // First task succeeds, second fails
      const returningFn = vi.fn()
        .mockResolvedValueOnce([{ ...fakeTask, id: 'task-a' }])
        .mockRejectedValueOnce(new Error('DB error'));
      const whereFn = vi.fn().mockReturnValue({ returning: returningFn });
      const setFn = vi.fn().mockReturnValue({ where: whereFn });
      mockDb.update.mockReturnValue({ set: setFn });

      const results = await bulkOperations({
        task_ids: ['task-a', 'task-b'],
        operation: 'update',
        fields: { title: 'Bulk' },
      }, 'user-1');

      expect(results).toHaveLength(2);
      expect(results[0]!.success).toBe(true);
      expect(results[1]!.success).toBe(false);
      expect(results[1]!.error).toBe('DB error');
    });
  });

  describe('TaskError', () => {
    it('creates error with code, message, and statusCode', () => {
      const error = new TaskError('NOT_FOUND', 'Task not found', 404);
      expect(error.code).toBe('NOT_FOUND');
      expect(error.message).toBe('Task not found');
      expect(error.statusCode).toBe(404);
      expect(error.name).toBe('TaskError');
      expect(error).toBeInstanceOf(Error);
    });

    it('defaults statusCode to 400', () => {
      const error = new TaskError('INVALID', 'Bad input');
      expect(error.statusCode).toBe(400);
    });
  });
});
