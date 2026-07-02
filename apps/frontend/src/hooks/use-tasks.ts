import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  Task,
  ApiResponse,
  PaginatedResponse,
  BoardResponse,
  CreateTaskInput,
  UpdateTaskInput,
  MoveTaskInput,
} from '@bigbluebam/shared';
import { api } from '@/lib/api';
import { useBoardStore } from '@/stores/board.store';

interface TaskFilters {
  sprint_id?: string;
  assignee_id?: string;
  priority?: string;
  phase_id?: string;
  search?: string;
}

export function useTasks(projectId: string | undefined, filters?: TaskFilters) {
  return useQuery({
    queryKey: ['tasks', projectId, filters],
    queryFn: () =>
      api.get<PaginatedResponse<Task>>(`/projects/${projectId}/tasks`, filters as Record<string, string>),
    enabled: !!projectId,
  });
}

export function useTask(taskId: string | undefined) {
  return useQuery({
    queryKey: ['tasks', 'detail', taskId],
    queryFn: () => api.get<ApiResponse<Task>>(`/tasks/${taskId}`),
    enabled: !!taskId,
  });
}

export function useBoard(projectId: string | undefined, sprintId?: string) {
  return useQuery({
    queryKey: ['board', projectId, sprintId],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (sprintId) params['sprint_id'] = sprintId;
      const res = await api.get<{ data: BoardResponse }>(`/projects/${projectId}/board`, params);
      return res.data;
    },
    enabled: !!projectId,
  });
}

export function useCreateTask() {
  const queryClient = useQueryClient();
  const addTaskToPhase = useBoardStore((s) => s.addTaskToPhase);

  return useMutation({
    mutationFn: ({ projectId, data }: { projectId: string; data: CreateTaskInput }) =>
      api.post<ApiResponse<Task>>(`/projects/${projectId}/tasks`, data),
    onSuccess: (response, variables) => {
      const task = response.data;
      addTaskToPhase(task.phase_id, task);
      queryClient.invalidateQueries({ queryKey: ['board', variables.projectId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', variables.projectId] });
      // If the new task was created as a subtask of another, the parent's
      // subtasks query needs to refresh so the new child appears in the
      // drawer's Subtasks section without the user reopening it.
      if (variables.data.parent_task_id) {
        queryClient.invalidateQueries({
          queryKey: ['tasks', 'subtasks', variables.data.parent_task_id],
        });
      }
    },
  });
}

export function useUpdateTask() {
  const queryClient = useQueryClient();
  const updateTaskInBoard = useBoardStore((s) => s.updateTaskInBoard);

  return useMutation({
    mutationFn: ({ taskId, data }: { taskId: string; data: UpdateTaskInput }) =>
      api.patch<ApiResponse<Task>>(`/tasks/${taskId}`, data),
    onMutate: async ({ taskId, data }) => {
      updateTaskInBoard(taskId, data as Partial<Task>);
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ['tasks', 'detail', variables.taskId] });
      queryClient.invalidateQueries({ queryKey: ['board'] });
      // A task's state/phase change can flip whether it counts as "done"
      // under any of its parents; refresh every open parent's subtask list.
      // (Cheap — the drawer is typically open on at most one task at a time.)
      queryClient.invalidateQueries({ queryKey: ['tasks', 'subtasks'] });
    },
    // A failed drag (optimistic write already applied in onMutate) OR a
    // server-side parent-date expansion that recomputes bounds must reconcile
    // against the source of truth. onSettled fires on both success and error,
    // so the board always refetches to the authoritative dates.
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['board'] });
    },
  });
}

export function useDeleteTask() {
  const queryClient = useQueryClient();
  const removeTaskFromBoard = useBoardStore((s) => s.removeTaskFromBoard);

  return useMutation({
    mutationFn: ({ taskId }: { taskId: string }) =>
      api.delete(`/tasks/${taskId}`),
    onMutate: async ({ taskId }) => {
      removeTaskFromBoard(taskId);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['board'] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });
}

// ─── Subtask many-to-many hooks (B3 Frndo Launch) ────────────────────────

export interface ParentTaskSummary {
  id: string;
  human_id: string | null;
  title: string;
  phase_id: string | null;
  state_id: string | null;
  completed_at: string | null;
  project_id: string;
}

export function useTaskParents(taskId: string | undefined) {
  return useQuery({
    queryKey: ['tasks', 'parents', taskId],
    queryFn: () => api.get<ApiResponse<ParentTaskSummary[]>>(`/tasks/${taskId}/parents`),
    enabled: !!taskId,
  });
}

/**
 * Subtasks of a task, unioning the legacy parent_task_id self-FK with the
 * task_parent_links many-to-many join table. Replaces the previously-unused
 * `task.subtasks` field embedded in the Task type — which was never
 * populated by the API, so the drawer's Subtasks block had silently been
 * empty for every task. Now it reads from the dedicated /tasks/:id/subtasks
 * endpoint and reflects both the primary-parent path and any additional
 * parents added via the Parent Tasks UI.
 */
export function useTaskSubtasks(taskId: string | undefined) {
  return useQuery({
    queryKey: ['tasks', 'subtasks', taskId],
    queryFn: () => api.get<ApiResponse<ParentTaskSummary[]>>(`/tasks/${taskId}/subtasks`),
    enabled: !!taskId,
  });
}

export function useAddTaskParent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, parentTaskId }: { taskId: string; parentTaskId: string }) =>
      api.post<ApiResponse<{ already_linked: boolean }>>(`/tasks/${taskId}/parents`, {
        parent_task_id: parentTaskId,
      }),
    onSuccess: (_res, { taskId, parentTaskId }) => {
      queryClient.invalidateQueries({ queryKey: ['tasks', 'parents', taskId] });
      // The parent now has one more subtask — invalidate its detail AND its
      // subtasks query so the drawer's Subtasks section picks up the new
      // child immediately.
      queryClient.invalidateQueries({ queryKey: ['tasks', 'detail', parentTaskId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', 'subtasks', parentTaskId] });
      queryClient.invalidateQueries({ queryKey: ['board'] });
    },
  });
}

export function useRemoveTaskParent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, parentTaskId }: { taskId: string; parentTaskId: string }) =>
      api.delete<ApiResponse<{ removed: boolean }>>(
        `/tasks/${taskId}/parents/${parentTaskId}`,
      ),
    onSuccess: (_res, { taskId, parentTaskId }) => {
      queryClient.invalidateQueries({ queryKey: ['tasks', 'parents', taskId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', 'detail', parentTaskId] });
      queryClient.invalidateQueries({ queryKey: ['tasks', 'subtasks', parentTaskId] });
      queryClient.invalidateQueries({ queryKey: ['board'] });
    },
  });
}

export function useMoveTask() {
  const queryClient = useQueryClient();
  const moveTask = useBoardStore((s) => s.moveTask);

  return useMutation({
    mutationFn: ({ taskId, data }: { taskId: string; data: MoveTaskInput }) =>
      api.post<ApiResponse<Task>>(`/tasks/${taskId}/move`, data),
    onMutate: async ({ taskId, data }) => {
      moveTask(taskId, data.phase_id, data.position);
    },
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: ['board'] });
    },
  });
}
