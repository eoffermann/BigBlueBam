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

export function useAddTaskParent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ taskId, parentTaskId }: { taskId: string; parentTaskId: string }) =>
      api.post<ApiResponse<{ already_linked: boolean }>>(`/tasks/${taskId}/parents`, {
        parent_task_id: parentTaskId,
      }),
    onSuccess: (_res, { taskId, parentTaskId }) => {
      queryClient.invalidateQueries({ queryKey: ['tasks', 'parents', taskId] });
      // The parent now has one more subtask — invalidate its detail too.
      queryClient.invalidateQueries({ queryKey: ['tasks', 'detail', parentTaskId] });
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
