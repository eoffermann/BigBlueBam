import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { BlueprintNode, BlueprintEdge } from './use-diagrams';

export interface CreateNodeInput {
  shape?: string;
  label?: string;
  description?: string;
  parent_node_id?: string | null;
  position_x?: number;
  position_y?: number;
  width?: number;
  height?: number;
  z_index?: number;
  pinned?: boolean;
  style?: Record<string, unknown>;
  data?: Record<string, unknown>;
  ref_entity_type?: string | null;
  ref_entity_id?: string | null;
}

export interface UpdateNodeInput {
  shape?: string;
  label?: string;
  description?: string | null;
  parent_node_id?: string | null;
  width?: number;
  height?: number;
  z_index?: number;
  pinned?: boolean;
  style?: Record<string, unknown>;
  data?: Record<string, unknown>;
  ref_entity_type?: string | null;
  ref_entity_id?: string | null;
}

export interface CreateEdgeInput {
  source_node_id: string;
  target_node_id: string;
  source_handle?: string | null;
  target_handle?: string | null;
  kind?: string;
  label?: string | null;
  marker_start?: string;
  marker_end?: string;
  style?: Record<string, unknown>;
}

export interface UpdateEdgeInput {
  source_handle?: string | null;
  target_handle?: string | null;
  kind?: string;
  label?: string | null;
  marker_start?: string;
  marker_end?: string;
  style?: Record<string, unknown>;
}

export interface LayoutInput {
  algorithm?: string;
  direction?: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT';
  spacing?: number;
}

export interface LayoutResult {
  algorithm?: string;
  positions: { id: string; x: number; y: number }[];
  status?: 'queued';
  message?: string;
}

function invalidateGraph(qc: ReturnType<typeof useQueryClient>, diagramId: string) {
  qc.invalidateQueries({ queryKey: ['blueprint', 'diagrams', diagramId, 'graph'] });
}

export function useCreateNode(diagramId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateNodeInput) =>
      api.post<{ data: BlueprintNode }>(`/diagrams/${diagramId}/nodes`, input),
    onSuccess: () => invalidateGraph(qc, diagramId),
  });
}

export function useUpdateNode(diagramId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, input }: { nodeId: string; input: UpdateNodeInput }) =>
      api.patch<{ data: BlueprintNode }>(`/diagrams/${diagramId}/nodes/${nodeId}`, input),
    onSuccess: () => invalidateGraph(qc, diagramId),
  });
}

export function useMoveNode(diagramId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      nodeId,
      position_x,
      position_y,
      pinned,
    }: {
      nodeId: string;
      position_x: number;
      position_y: number;
      pinned?: boolean;
    }) =>
      api.post<{ data: BlueprintNode }>(`/diagrams/${diagramId}/nodes/${nodeId}/move`, {
        position_x,
        position_y,
        pinned,
      }),
    // Movement is optimistic on the canvas; we don't refetch the graph
    // on every drag-end. Instead the editor merges the response into
    // local state and only invalidates if the mutation fails.
    onError: () => invalidateGraph(qc, diagramId),
  });
}

export function useDeleteNode(diagramId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (nodeId: string) => api.delete(`/diagrams/${diagramId}/nodes/${nodeId}`),
    onSuccess: () => invalidateGraph(qc, diagramId),
  });
}

export interface DuplicateNodeArgs {
  nodeId: string;
  offset_x?: number;
  offset_y?: number;
}

export function useDuplicateNode(diagramId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, offset_x, offset_y }: DuplicateNodeArgs) =>
      api.post<{ data: BlueprintNode }>(`/diagrams/${diagramId}/nodes/${nodeId}/duplicate`, {
        offset_x,
        offset_y,
      }),
    onSuccess: () => invalidateGraph(qc, diagramId),
  });
}

export function useCreateEdge(diagramId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateEdgeInput) =>
      api.post<{ data: BlueprintEdge }>(`/diagrams/${diagramId}/edges`, input),
    onSuccess: () => invalidateGraph(qc, diagramId),
  });
}

export function useUpdateEdge(diagramId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ edgeId, input }: { edgeId: string; input: UpdateEdgeInput }) =>
      api.patch<{ data: BlueprintEdge }>(`/diagrams/${diagramId}/edges/${edgeId}`, input),
    onSuccess: () => invalidateGraph(qc, diagramId),
  });
}

export function useDeleteEdge(diagramId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (edgeId: string) => api.delete(`/diagrams/${diagramId}/edges/${edgeId}`),
    onSuccess: () => invalidateGraph(qc, diagramId),
  });
}

export function useApplyLayout(diagramId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: LayoutInput) =>
      api.post<{ data: LayoutResult }>(`/diagrams/${diagramId}/layout`, input),
    onSuccess: () => invalidateGraph(qc, diagramId),
  });
}

/**
 * Export a diagram to JSON or Mermaid. Returns the raw response body as
 * a string. The api client downgrades to text() automatically when the
 * server doesn't send `application/json`.
 */
export function useExport(diagramId: string) {
  return useMutation({
    mutationFn: async (format: 'json' | 'mermaid'): Promise<string> => {
      const result = await api.get<string | { data: unknown }>(`/diagrams/${diagramId}/export`, { format });
      if (typeof result === 'string') return result;
      // JSON export response is structured `{ data: {...} }` per the
      // common envelope; we stringify it so callers get a single
      // string they can pipe straight to download.
      return JSON.stringify(result, null, 2);
    },
  });
}

/* ------------------------------------------------------------------ */
/*  Cross-product: promote graph → Bam tasks                          */
/* ------------------------------------------------------------------ */

export interface PromoteGraphInput {
  project_id: string;
  phase_id?: string | null;
  sprint_id?: string | null;
  edge_direction?: 'source-parent' | 'target-parent' | 'none';
}

export interface PromoteGraphPlan {
  diagram_id: string;
  project_id: string;
  edge_direction: 'source-parent' | 'target-parent' | 'none';
  tasks_to_create: Array<{
    blueprint_node_id: string;
    payload: {
      title: string;
      description: string | null;
      phase_id: string | null;
      sprint_id: string | null;
      priority: 'medium';
    };
    existing_task_id: string | null;
  }>;
  parent_links_to_create: Array<{
    source_edge_id: string;
    child_blueprint_node_id: string;
    parent_blueprint_node_id: string;
  }>;
  total_steps: number;
}

export function usePromoteGraphPlan(diagramId: string) {
  return useMutation({
    mutationFn: (input: PromoteGraphInput) =>
      api.post<{ data: PromoteGraphPlan }>(
        `/diagrams/${diagramId}/promote-to-tasks`,
        input,
      ),
  });
}

export function useImportMermaid(diagramId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ source, replace }: { source: string; replace?: boolean }) =>
      api.post<{ data: { node_count: number; edge_count: number } }>(`/diagrams/${diagramId}/import`, {
        format: 'mermaid',
        source,
        replace,
      }),
    onSuccess: () => invalidateGraph(qc, diagramId),
  });
}
