import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ── Types ──

export type MetricType = 'percentage' | 'number' | 'currency' | 'boolean';

export interface KeyResult {
  id: string;
  goal_id: string;
  title: string;
  description: string | null;
  metric_type: MetricType;
  start_value: number;
  current_value: number;
  target_value: number;
  unit: string | null;
  progress: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface KrLink {
  id: string;
  key_result_id: string;
  link_type: 'project' | 'epic' | 'task_query';
  link_id: string;
  link_title: string;
  link_url: string | null;
}

export interface KrHistoryEntry {
  id: string;
  key_result_id: string;
  value: string;
  progress: string;
  recorded_at: string;
  created_at: string;
}

// ── Response types ──

interface ListResponse {
  data: KeyResult[];
}

interface SingleResponse {
  data: KeyResult;
}

interface LinksResponse {
  data: KrLink[];
}

interface HistoryResponse {
  data: KrHistoryEntry[];
}

// ── Hooks ──

export function useKeyResults(goalId: string | undefined) {
  return useQuery({
    queryKey: ['key-results', 'list', goalId],
    queryFn: () => api.get<ListResponse>(`/goals/${goalId}/key-results`),
    enabled: !!goalId,
    staleTime: 15_000,
  });
}

export function useKeyResult(id: string | undefined) {
  return useQuery({
    queryKey: ['key-results', 'detail', id],
    queryFn: () => api.get<SingleResponse>(`/key-results/${id}`),
    enabled: !!id,
  });
}

export function useCreateKeyResult() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      goal_id: string;
      title: string;
      description?: string;
      metric_type: MetricType;
      start_value: number;
      target_value: number;
      unit?: string;
    }) => api.post<SingleResponse>(`/goals/${data.goal_id}/key-results`, data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['key-results', 'list', variables.goal_id] });
      qc.invalidateQueries({ queryKey: ['goals'] });
    },
  });
}

export function useUpdateKeyResult() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; goal_id: string } & Partial<Pick<KeyResult, 'title' | 'description' | 'metric_type' | 'start_value' | 'target_value' | 'unit'>>) =>
      api.patch<SingleResponse>(`/key-results/${id}`, data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['key-results', 'list', variables.goal_id] });
      qc.invalidateQueries({ queryKey: ['key-results', 'detail', variables.id] });
      qc.invalidateQueries({ queryKey: ['goals'] });
    },
  });
}

export function useDeleteKeyResult() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ id, goalId: _goalId }: { id: string; goalId: string }) =>
      api.delete(`/key-results/${id}`),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['key-results', 'list', variables.goalId] });
      qc.invalidateQueries({ queryKey: ['goals'] });
    },
  });
}

export function useSetKrValue() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ id, goalId: _goalId, value, note }: { id: string; goalId: string; value: number; note?: string }) =>
      api.post<SingleResponse>(`/key-results/${id}/value`, { value, note }),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['key-results', 'list', variables.goalId] });
      qc.invalidateQueries({ queryKey: ['key-results', 'detail', variables.id] });
      qc.invalidateQueries({ queryKey: ['key-results', 'history', variables.id] });
      qc.invalidateQueries({ queryKey: ['goals'] });
    },
  });
}

// ── Links ──

export function useKrLinks(keyResultId: string | undefined) {
  return useQuery({
    queryKey: ['key-results', 'links', keyResultId],
    queryFn: () => api.get<LinksResponse>(`/key-results/${keyResultId}/links`),
    enabled: !!keyResultId,
  });
}

export function useAddKrLink() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ keyResultId, ...data }: {
      keyResultId: string;
      link_type: KrLink['link_type'];
      link_id: string;
      link_title: string;
      link_url?: string;
    }) => api.post(`/key-results/${keyResultId}/links`, data),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['key-results', 'links', variables.keyResultId] });
    },
  });
}

export function useRemoveKrLink() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ keyResultId, linkId }: { keyResultId: string; linkId: string }) =>
      api.delete(`/key-results/${keyResultId}/links/${linkId}`),
    onSuccess: (_data, variables) => {
      qc.invalidateQueries({ queryKey: ['key-results', 'links', variables.keyResultId] });
    },
  });
}

// ── History ──

export function useKrHistory(keyResultId: string | undefined) {
  return useQuery({
    queryKey: ['key-results', 'history', keyResultId],
    queryFn: () => api.get<HistoryResponse>(`/key-results/${keyResultId}/history`),
    enabled: !!keyResultId,
  });
}
