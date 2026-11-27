import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { User } from '@bigbluebam/shared';

vi.mock('@/lib/api', () => ({
  api: {
    get: vi.fn(),
    getQuiet: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  ApiError: class extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

import { api, ApiError } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { useBoardStore } from '@/stores/board.store';

const mockUser: User = {
  id: 'user-1',
  email: 'test@example.com',
  display_name: 'Test User',
  avatar_url: null,
  timezone: 'UTC',
  notification_prefs: {},
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
};

// ─── Auth Store ──────────────────────────────────────────────────────────────

describe('useAuthStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAuthStore.setState({
      user: null,
      isAuthenticated: false,
      isLoading: true,
      error: null,
    });
  });

  it('has correct initial state', () => {
    const state = useAuthStore.getState();
    expect(state.isLoading).toBe(true);
    expect(state.isAuthenticated).toBe(false);
    expect(state.user).toBeNull();
    expect(state.error).toBeNull();
  });

  describe('fetchMe', () => {
    it('sets user and isAuthenticated on success', async () => {
      vi.mocked(api.getQuiet).mockResolvedValue({ data: mockUser });

      await useAuthStore.getState().fetchMe();

      const state = useAuthStore.getState();
      expect(state.user).toEqual(mockUser);
      expect(state.isAuthenticated).toBe(true);
      expect(state.isLoading).toBe(false);
    });

    it('sets isAuthenticated false and isLoading false on failure', async () => {
      vi.mocked(api.getQuiet).mockRejectedValue(new Error('Network error'));

      await useAuthStore.getState().fetchMe();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.isAuthenticated).toBe(false);
      expect(state.isLoading).toBe(false);
    });

    it('calls api.getQuiet with /auth/me', async () => {
      vi.mocked(api.getQuiet).mockResolvedValue({ data: mockUser });

      await useAuthStore.getState().fetchMe();

      expect(api.getQuiet).toHaveBeenCalledWith('/auth/me');
    });
  });

  describe('login', () => {
    it('sets user data from response on success', async () => {
      vi.mocked(api.post).mockResolvedValue({ data: { user: mockUser } });

      await useAuthStore.getState().login('test@example.com', 'password123');

      const state = useAuthStore.getState();
      expect(state.user).toEqual(mockUser);
      expect(state.isAuthenticated).toBe(true);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    });

    it('sets error message and throws on failure with ApiError', async () => {
      const apiError = new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid credentials');
      vi.mocked(api.post).mockRejectedValue(apiError);

      await expect(
        useAuthStore.getState().login('bad@example.com', 'wrong'),
      ).rejects.toThrow(apiError);

      const state = useAuthStore.getState();
      expect(state.error).toMatchObject({ message: 'Invalid credentials' });
      expect(state.isLoading).toBe(false);
      expect(state.isAuthenticated).toBe(false);
    });

    it('sets generic error message for non-ApiError failures', async () => {
      vi.mocked(api.post).mockRejectedValue(new Error('Network error'));

      let thrown: unknown;
      try {
        await useAuthStore.getState().login('test@example.com', 'password');
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe('Network error');

      const state = useAuthStore.getState();
      expect(state.error).toMatchObject({ message: 'Login failed' });
    });

    it('clears previous error before attempting login', async () => {
      useAuthStore.setState({ error: { message: 'Previous error' } });
      vi.mocked(api.post).mockResolvedValue({ data: { user: mockUser } });

      await useAuthStore.getState().login('test@example.com', 'password');

      expect(useAuthStore.getState().error).toBeNull();
    });

    it('calls api.post with correct path and body', async () => {
      vi.mocked(api.post).mockResolvedValue({ data: { user: mockUser } });

      await useAuthStore.getState().login('test@example.com', 'pass123');

      expect(api.post).toHaveBeenCalledWith('/auth/login', {
        email: 'test@example.com',
        password: 'pass123',
      });
    });
  });

  describe('logout', () => {
    it('clears user and isAuthenticated', async () => {
      useAuthStore.setState({
        user: mockUser,
        isAuthenticated: true,
        isLoading: false,
      });
      vi.mocked(api.post).mockResolvedValue(undefined);

      await useAuthStore.getState().logout();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.isAuthenticated).toBe(false);
    });

    it('clears state even if api call fails', async () => {
      useAuthStore.setState({
        user: mockUser,
        isAuthenticated: true,
        isLoading: false,
      });
      vi.mocked(api.post).mockRejectedValue(new Error('Server down'));

      await useAuthStore.getState().logout();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.isAuthenticated).toBe(false);
    });
  });

  describe('clearError', () => {
    it('clears the error', () => {
      useAuthStore.setState({ error: { message: 'Something went wrong' } });

      useAuthStore.getState().clearError();

      expect(useAuthStore.getState().error).toBeNull();
    });

    it('is a no-op when error is already null', () => {
      useAuthStore.setState({ error: null });

      useAuthStore.getState().clearError();

      expect(useAuthStore.getState().error).toBeNull();
    });
  });
});

// ─── Board Store ─────────────────────────────────────────────────────────────

const makeTask = (overrides: Partial<import('@bigbluebam/shared').Task> = {}): import('@bigbluebam/shared').Task => ({
  id: 'task-1',
  project_id: 'proj-1',
  human_id: 'BBB-1',
  title: 'Test Task',
  description: null,
  description_plain: null,
  phase_id: 'phase-1',
  state_id: null,
  sprint_id: null,
  assignee_id: null,
  reporter_id: 'user-1',
  priority: 'medium',
  story_points: null,
  time_estimate_minutes: null,
  time_logged_minutes: 0,
  position: 0,
  start_date: null,
  due_date: null,
  completed_at: null,
  epic_id: null,
  parent_task_id: null,
  labels: [],
  watchers: [],
  is_blocked: false,
  blocking_task_ids: [],
  blocked_by_task_ids: [],
  custom_fields: {},
  attachment_count: 0,
  comment_count: 0,
  subtask_count: 0,
  subtask_done_count: 0,
  carry_forward_count: 0,
  original_sprint_id: null,
  links: [],
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
  ...overrides,
});

const makePhase = (
  id: string,
  tasks: import('@bigbluebam/shared').Task[] = [],
): import('@bigbluebam/shared').Phase & { tasks: import('@bigbluebam/shared').Task[] } => ({
  id,
  project_id: 'proj-1',
  name: `Phase ${id}`,
  description: null,
  color: null,
  position: 0,
  wip_limit: null,
  is_start: false,
  is_terminal: false,
  auto_state_on_enter: null,
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
  tasks,
});

describe('useBoardStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useBoardStore.setState({
      phases: [],
      activeSprint: null,
      isLoading: false,
      error: null,
    });
  });

  it('has correct initial state', () => {
    const state = useBoardStore.getState();
    expect(state.phases).toEqual([]);
    expect(state.activeSprint).toBeNull();
    expect(state.isLoading).toBe(false);
    expect(state.error).toBeNull();
  });

  describe('fetchBoard', () => {
    it('fetches board data and sets phases and activeSprint', async () => {
      const phases = [makePhase('phase-1', [makeTask()])];
      const sprint = {
        id: 'sprint-1',
        project_id: 'proj-1',
        name: 'Sprint 1',
        goal: null,
        status: 'active' as const,
        start_date: '2025-01-01',
        end_date: '2025-01-14',
        completed_at: null,
        created_at: '2025-01-01T00:00:00Z',
        updated_at: '2025-01-01T00:00:00Z',
      };

      vi.mocked(api.get).mockResolvedValue({
        data: {
          phases,
          sprint,
          project: { id: 'proj-1' },
        },
      });

      await useBoardStore.getState().fetchBoard('proj-1', 'sprint-1');

      const state = useBoardStore.getState();
      expect(state.phases).toEqual(phases);
      expect(state.activeSprint).toEqual(sprint);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBeNull();
    });

    it('sets error on failure', async () => {
      vi.mocked(api.get).mockRejectedValue(new Error('Server error'));

      await useBoardStore.getState().fetchBoard('proj-1');

      const state = useBoardStore.getState();
      expect(state.isLoading).toBe(false);
      expect(state.error).toBe('Server error');
    });

    it('passes sprint_id as params when provided', async () => {
      vi.mocked(api.get).mockResolvedValue({ data: { phases: [], sprint: null, project: {} } });

      await useBoardStore.getState().fetchBoard('proj-1', 'sprint-99');

      expect(api.get).toHaveBeenCalledWith('/projects/proj-1/board', { sprint_id: 'sprint-99' });
    });

    it('passes empty params when sprintId is not provided', async () => {
      vi.mocked(api.get).mockResolvedValue({ data: { phases: [], sprint: null, project: {} } });

      await useBoardStore.getState().fetchBoard('proj-1');

      expect(api.get).toHaveBeenCalledWith('/projects/proj-1/board', {});
    });
  });

  describe('moveTask', () => {
    it('moves a task from one phase to another', () => {
      const task = makeTask({ id: 'task-1', phase_id: 'phase-1', position: 0 });
      useBoardStore.setState({
        phases: [makePhase('phase-1', [task]), makePhase('phase-2', [])],
      });

      useBoardStore.getState().moveTask('task-1', 'phase-2', 0);

      const state = useBoardStore.getState();
      expect(state.phases.find((p) => p.id === 'phase-1')!.tasks).toHaveLength(0);
      expect(state.phases.find((p) => p.id === 'phase-2')!.tasks).toHaveLength(1);
      expect(state.phases.find((p) => p.id === 'phase-2')!.tasks[0]!.id).toBe('task-1');
      expect(state.phases.find((p) => p.id === 'phase-2')!.tasks[0]!.phase_id).toBe('phase-2');
    });

    it('inserts task at the correct position', () => {
      const taskA = makeTask({ id: 'task-a', phase_id: 'phase-2', position: 0 });
      const taskB = makeTask({ id: 'task-b', phase_id: 'phase-1', position: 0 });
      useBoardStore.setState({
        phases: [makePhase('phase-1', [taskB]), makePhase('phase-2', [taskA])],
      });

      useBoardStore.getState().moveTask('task-b', 'phase-2', 0);

      const phase2 = useBoardStore.getState().phases.find((p) => p.id === 'phase-2')!;
      expect(phase2.tasks).toHaveLength(2);
      expect(phase2.tasks[0]!.id).toBe('task-b');
      expect(phase2.tasks[1]!.id).toBe('task-a');
    });

    it('is a no-op for nonexistent task', () => {
      useBoardStore.setState({
        phases: [makePhase('phase-1', [makeTask()])],
      });

      const before = useBoardStore.getState().phases;
      useBoardStore.getState().moveTask('nonexistent', 'phase-1', 0);
      const after = useBoardStore.getState().phases;

      expect(after).toEqual(before);
    });

    it('updates positions after move', () => {
      const taskA = makeTask({ id: 'task-a', phase_id: 'phase-2', position: 0 });
      const taskB = makeTask({ id: 'task-b', phase_id: 'phase-2', position: 1 });
      const taskC = makeTask({ id: 'task-c', phase_id: 'phase-1', position: 0 });
      useBoardStore.setState({
        phases: [makePhase('phase-1', [taskC]), makePhase('phase-2', [taskA, taskB])],
      });

      useBoardStore.getState().moveTask('task-c', 'phase-2', 1);

      const phase2 = useBoardStore.getState().phases.find((p) => p.id === 'phase-2')!;
      expect(phase2.tasks.map((t) => t.position)).toEqual([0, 1, 2]);
    });
  });

  describe('addTaskToPhase', () => {
    it('adds a task to the specified phase', () => {
      useBoardStore.setState({ phases: [makePhase('phase-1', [])] });
      const task = makeTask({ id: 'new-task' });

      useBoardStore.getState().addTaskToPhase('phase-1', task);

      const phase = useBoardStore.getState().phases.find((p) => p.id === 'phase-1')!;
      expect(phase.tasks).toHaveLength(1);
      expect(phase.tasks[0]!.id).toBe('new-task');
    });

    it('does not affect other phases', () => {
      useBoardStore.setState({
        phases: [makePhase('phase-1', []), makePhase('phase-2', [makeTask()])],
      });

      useBoardStore.getState().addTaskToPhase('phase-1', makeTask({ id: 'new-task' }));

      expect(useBoardStore.getState().phases.find((p) => p.id === 'phase-2')!.tasks).toHaveLength(1);
    });
  });

  describe('updateTaskInBoard', () => {
    it('updates a task with the provided partial', () => {
      const task = makeTask({ id: 'task-1', title: 'Old Title' });
      useBoardStore.setState({ phases: [makePhase('phase-1', [task])] });

      useBoardStore.getState().updateTaskInBoard('task-1', { title: 'New Title' });

      const updated = useBoardStore.getState().phases[0]!.tasks[0]!;
      expect(updated.title).toBe('New Title');
      expect(updated.id).toBe('task-1');
    });

    it('does not modify other tasks', () => {
      const task1 = makeTask({ id: 'task-1', title: 'Task 1' });
      const task2 = makeTask({ id: 'task-2', title: 'Task 2' });
      useBoardStore.setState({ phases: [makePhase('phase-1', [task1, task2])] });

      useBoardStore.getState().updateTaskInBoard('task-1', { title: 'Updated' });

      expect(useBoardStore.getState().phases[0]!.tasks[1]!.title).toBe('Task 2');
    });
  });

  describe('removeTaskFromBoard', () => {
    it('removes the task from its phase', () => {
      const task = makeTask({ id: 'task-1' });
      useBoardStore.setState({ phases: [makePhase('phase-1', [task])] });

      useBoardStore.getState().removeTaskFromBoard('task-1');

      expect(useBoardStore.getState().phases[0]!.tasks).toHaveLength(0);
    });

    it('does not remove other tasks', () => {
      const task1 = makeTask({ id: 'task-1' });
      const task2 = makeTask({ id: 'task-2' });
      useBoardStore.setState({ phases: [makePhase('phase-1', [task1, task2])] });

      useBoardStore.getState().removeTaskFromBoard('task-1');

      expect(useBoardStore.getState().phases[0]!.tasks).toHaveLength(1);
      expect(useBoardStore.getState().phases[0]!.tasks[0]!.id).toBe('task-2');
    });
  });
});
