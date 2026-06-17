import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { usePeriodStore } from '@/stores/period.store';

// ── Types ──

export type GoalStatus = 'draft' | 'on_track' | 'at_risk' | 'behind' | 'achieved' | 'missed';
export type GoalScope = 'organization' | 'team' | 'project' | 'individual';

export interface GoalOwner {
  id: string;
  display_name: string;
  avatar_url: string | null;
}

export interface BearingGoal {
  id: string;
  organization_id: string;
  title: string;
  description: string | null;
  scope: GoalScope;
  status: GoalStatus;
  status_override: boolean;
  progress: string;
  owner_id: string | null;
  owner?: GoalOwner | null;
  period_id: string;
  period_name?: string | null;
  project_id: string | null;
  project_name?: string | null;
  team_name: string | null;
  icon: string | null;
  color: string | null;
  key_result_count?: number;
  watcher_count?: number;
  expected_progress?: number;
  computed_status?: string;
  key_results?: unknown[];
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface GoalUpdate {
  id: string;
  goal_id: string;
  author: GoalOwner;
  body: string;
  status_at_time: GoalStatus;
  progress_at_time: number;
  created_at: string;
}

export interface GoalWatcher {
  id: string;
  user_id: string;
  display_name: string;
  avatar_url: string | null;
}

export interface GoalHistoryEntry {
  id: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  changed_by: GoalOwner;
  created_at: string;
}

// ── Response types ──

interface ListResponse {
  data: BearingGoal[];
  meta: { next_cursor: string | null; has_more: boolean; total?: number };
}

interface SingleResponse {
  data: BearingGoal;
}

interface UpdatesResponse {
  data: GoalUpdate[];
}

interface WatchersResponse {
  data: GoalWatcher[];
}

interface HistoryResponse {
  data: GoalHistoryEntry[];
}

// ── Hooks ──

export function useGoals(filters?: {
  scope?: GoalScope;
  status?: GoalStatus;
  owner_id?: string;
  search?: string;
  cursor?: string;
}) {
  const periodId = usePeriodStore((s) => s.selectedPeriodId);

  return useQuery({
    queryKey: ['goals', 'list', periodId, filters],
    queryFn: () =>
      api.get<ListResponse>('/goals', {
        period_id: periodId ?? undefined,
        'filter[scope]': filters?.scope,
        'filter[status]': filters?.status,
        'filter[owner_id]': filters?.owner_id,
        search: filters?.search,
        cursor: filters?.cursor,
      }),
    staleTime: 15_000,
    enabled: !!periodId,
  });
}

export function useGoal(id: string | undefined) {
  return useQuery({
    queryKey: ['goals', 'detail', id],
    queryFn: () => api.get<SingleResponse>(`/goals/${id}`),
    enabled: !!id,
  });
}

export function useCreateGoal() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      title: string;
      description?: string;
      scope: GoalScope;
      period_id: string;
      owner_id: string;
      project_id?: string;
      team_name?: string;
    }) => api.post<SingleResponse>('/goals', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['goals'] });
    },
  });
}

export function useUpdateGoal() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Partial<Pick<BearingGoal, 'title' | 'description' | 'scope' | 'owner_id' | 'project_id' | 'team_name'>>) =>
      api.patch<SingleResponse>(`/goals/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['goals'] });
    },
  });
}

export function useDeleteGoal() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.delete(`/goals/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['goals'] });
    },
  });
}

export function useOverrideStatus() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: GoalStatus }) =>
      api.post<SingleResponse>(`/goals/${id}/status`, { status }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['goals'] });
    },
  });
}

// ── Updates (status updates / check-ins) ──

export function useGoalUpdates(goalId: string | undefined) {
  return useQuery({
    queryKey: ['goals', 'updates', goalId],
    queryFn: () => api.get<UpdatesResponse>(`/goals/${goalId}/updates`),
    enabled: !!goalId,
  });
}

export function usePostUpdate() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ goalId, body, status, progress }: {
      goalId: string;
      body: string;
      status?: GoalStatus;
      progress?: number;
    }) => api.post<{ data: GoalUpdate }>(`/goals/${goalId}/updates`, { body, status, progress }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['goals', 'updates', variables.goalId] });
      qc.invalidateQueries({ queryKey: ['goals', 'detail', variables.goalId] });
      qc.invalidateQueries({ queryKey: ['goals', 'list'] });
    },
  });
}

// ── Watchers ──

export function useGoalWatchers(goalId: string | undefined) {
  return useQuery({
    queryKey: ['goals', 'watchers', goalId],
    queryFn: () => api.get<WatchersResponse>(`/goals/${goalId}/watchers`),
    enabled: !!goalId,
  });
}

export function useAddWatcher() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ goalId, userId }: { goalId: string; userId: string }) =>
      api.post(`/goals/${goalId}/watchers`, { user_id: userId }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['goals', 'watchers', variables.goalId] });
    },
  });
}

export function useRemoveWatcher() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ goalId, userId }: { goalId: string; userId: string }) =>
      api.delete(`/goals/${goalId}/watchers/${userId}`),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['goals', 'watchers', variables.goalId] });
    },
  });
}

// ── History ──

export function useGoalHistory(goalId: string | undefined) {
  return useQuery({
    queryKey: ['goals', 'history', goalId],
    queryFn: () => api.get<HistoryResponse>(`/goals/${goalId}/history`),
    enabled: !!goalId,
  });
}
