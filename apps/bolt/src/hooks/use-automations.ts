import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { BoltGraph } from '@/types/bolt-graph';
import { api } from '@/lib/api';
import { useProjectStore } from '@/stores/project.store';

// ─── Types ───

export type TriggerSource =
  | 'bam'
  | 'banter'
  | 'beacon'
  | 'brief'
  | 'helpdesk'
  | 'schedule'
  | 'bond'
  | 'blast'
  | 'board'
  | 'bench'
  | 'bearing'
  | 'bill'
  | 'book'
  | 'blank';
export type ExecutionStatus = 'running' | 'success' | 'partial' | 'failed' | 'skipped';
export type ConditionOperator =
  | 'equals'
  | 'not_equals'
  | 'contains'
  | 'not_contains'
  | 'starts_with'
  | 'ends_with'
  | 'greater_than'
  | 'less_than'
  | 'is_empty'
  | 'is_not_empty'
  | 'in'
  | 'not_in'
  | 'matches_regex';
export type ErrorPolicy = 'stop' | 'continue' | 'retry';

export interface BoltCondition {
  id: string;
  field: string;
  operator: ConditionOperator;
  value: unknown;
  logic_group: 'and' | 'or';
  sort_order: number;
}

export interface BoltAction {
  id: string;
  mcp_tool: string;
  parameters: Record<string, unknown>;
  sort_order: number;
  on_error: ErrorPolicy;
  retry_count: number;
}

export interface BoltAutomation {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger_source: TriggerSource;
  trigger_event: string;
  trigger_filter: Record<string, unknown> | null;
  cron_expression: string | null;
  cron_timezone: string | null;
  conditions: BoltCondition[];
  actions: BoltAction[];
  max_executions_per_hour: number;
  cooldown_seconds: number;
  last_executed_at: string | null;
  project_id: string | null;
  project_name: string | null;
  created_by: string;
  creator_name: string | null;
  graph: BoltGraph | null;
  created_at: string;
  updated_at: string;
}

export interface AutomationStats {
  total: number;
  enabled: number;
  disabled: number;
  by_source: Record<string, number>;
}

// ─── Response types ───

interface ListResponse {
  data: BoltAutomation[];
  meta: { next_cursor: string | null; has_more: boolean };
}

interface SingleResponse {
  data: BoltAutomation;
}

interface StatsResponse {
  data: AutomationStats;
}

// ─── Hooks ───

export function useAutomationList(filters?: {
  source?: TriggerSource;
  enabled?: boolean;
  search?: string;
  cursor?: string;
}) {
  const projectId = useProjectStore((s) => s.activeProjectId);

  return useQuery({
    queryKey: ['automations', 'list', projectId, filters],
    queryFn: () =>
      api.get<ListResponse>('/automations', {
        project_id: projectId ?? undefined,
        // The API's Zod schema uses flat keys, NOT filter[...] brackets.
        // Unknown keys are stripped silently, so the bracket form was a no-op
        // and the source/enabled chips never reached the server.
        trigger_source: filters?.source,
        enabled: filters?.enabled != null ? String(filters.enabled) : undefined,
        search: filters?.search,
        cursor: filters?.cursor,
      }),
    staleTime: 15_000,
  });
}

export function useAutomation(id: string | undefined) {
  return useQuery({
    queryKey: ['automations', 'detail', id],
    queryFn: () => api.get<SingleResponse>(`/automations/${id}`),
    enabled: !!id,
  });
}

export function useAutomationStats() {
  const projectId = useProjectStore((s) => s.activeProjectId);

  return useQuery({
    queryKey: ['automations', 'stats', projectId],
    queryFn: () =>
      api.get<StatsResponse>('/automations/stats', {
        project_id: projectId ?? undefined,
      }),
    staleTime: 30_000,
  });
}

export function useCreateAutomation() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (data: Partial<BoltAutomation>) => api.post<SingleResponse>('/automations', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['automations'] });
    },
  });
}

export function useUpdateAutomation() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: ({ id, ...data }: Partial<BoltAutomation> & { id: string }) =>
      api.put<SingleResponse>(`/automations/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['automations'] });
    },
  });
}

export function useDeleteAutomation() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.delete(`/automations/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['automations'] });
    },
  });
}

export function useEnableAutomation() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.post<SingleResponse>(`/automations/${id}/enable`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['automations'] });
    },
  });
}

export function useDisableAutomation() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.post<SingleResponse>(`/automations/${id}/disable`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['automations'] });
    },
  });
}

export function useDuplicateAutomation() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: (id: string) => api.post<SingleResponse>(`/automations/${id}/duplicate`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['automations'] });
    },
  });
}

/**
 * Result of a dry-run test against the `/automations/:id/test` route. The
 * route only EVALUATES CONDITIONS against the simulated event; it does not
 * execute actions. It returns whether the conditions passed, a per-condition
 * evaluation log, and a human-readable summary message.
 */
export interface AutomationTestResult {
  passed: boolean;
  log: Array<{
    field: string;
    operator: string;
    expected: unknown;
    actual: unknown;
    result: boolean;
  }>;
  message: string;
}

/**
 * Test-run an automation. The `/test` route requires an `event` object (the
 * simulated event payload) in the body — omitting it returns 400. We default
 * to an empty object so the route validates even when the caller has no
 * specific payload to simulate.
 */
export function useTestAutomation() {
  return useMutation({
    mutationFn: ({ id, event }: { id: string; event?: Record<string, unknown> }) =>
      api.post<{ data: AutomationTestResult }>(`/automations/${id}/test`, {
        event: event ?? {},
      }),
  });
}
