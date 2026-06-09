import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface Diagram {
  id: string;
  org_id: string;
  project_id: string | null;
  created_by: string | null;
  name: string;
  slug: string | null;
  description: string | null;
  diagram_type: string;
  layout_algorithm: string;
  layout_options: Record<string, unknown>;
  canvas_settings: Record<string, unknown>;
  visibility: 'organization' | 'project' | 'private';
  thumbnail_key: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
  starred?: boolean;
}

export interface BlueprintNode {
  id: string;
  diagram_id: string;
  parent_node_id: string | null;
  shape: string;
  label: string;
  description: string | null;
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  z_index: number;
  pinned: boolean;
  style: Record<string, unknown>;
  data: Record<string, unknown>;
  ref_entity_type: string | null;
  ref_entity_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface BlueprintEdge {
  id: string;
  diagram_id: string;
  source_node_id: string;
  target_node_id: string;
  source_handle: string | null;
  target_handle: string | null;
  kind: string;
  label: string | null;
  marker_start: string;
  marker_end: string;
  style: Record<string, unknown>;
  waypoints: { x: number; y: number }[] | null;
  created_at: string;
  updated_at: string;
}

export interface DiagramGraph {
  diagram: Diagram;
  nodes: BlueprintNode[];
  edges: BlueprintEdge[];
}

export interface DiagramTemplate {
  id: string;
  org_id: string | null;
  name: string;
  description: string | null;
  diagram_type: string;
  definition: Record<string, unknown>;
  is_system: boolean;
  thumbnail_key: string | null;
  created_at: string;
}

export interface DiagramVersion {
  id: string;
  diagram_id: string;
  version_number: number;
  label: string | null;
  created_by: string | null;
  created_at: string;
  node_count?: number;
  edge_count?: number;
}

export interface DiagramFilter {
  project_id?: string;
  diagram_type?: string;
  starred?: boolean;
  include_archived?: boolean;
}

export function useDiagrams(filter: DiagramFilter = {}) {
  return useQuery({
    queryKey: ['blueprint', 'diagrams', filter],
    queryFn: () =>
      api.get<{ data: Diagram[] }>('/diagrams', {
        project_id: filter.project_id,
        diagram_type: filter.diagram_type,
        starred: filter.starred ? 'true' : undefined,
        include_archived: filter.include_archived ? 'true' : undefined,
      }),
  });
}

export function useDiagram(id: string | undefined) {
  return useQuery({
    queryKey: ['blueprint', 'diagrams', id],
    queryFn: () => api.get<{ data: Diagram }>(`/diagrams/${id}`),
    enabled: !!id,
  });
}

export function useDiagramGraph(id: string | undefined) {
  return useQuery({
    queryKey: ['blueprint', 'diagrams', id, 'graph'],
    queryFn: () => api.get<{ data: DiagramGraph }>(`/diagrams/${id}/graph`),
    enabled: !!id,
  });
}

export function useTemplates() {
  return useQuery({
    queryKey: ['blueprint', 'templates'],
    queryFn: () => api.get<{ data: DiagramTemplate[] }>('/templates'),
  });
}

export function useVersions(id: string | undefined) {
  return useQuery({
    queryKey: ['blueprint', 'diagrams', id, 'versions'],
    queryFn: () => api.get<{ data: DiagramVersion[] }>(`/diagrams/${id}/versions`),
    enabled: !!id,
  });
}

export interface CreateDiagramInput {
  name: string;
  description?: string;
  project_id?: string | null;
  diagram_type?: string;
  layout_algorithm?: string;
  visibility?: 'organization' | 'project' | 'private';
  layout_options?: Record<string, unknown>;
  canvas_settings?: Record<string, unknown>;
  template_id?: string;
}

export function useCreateDiagram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateDiagramInput) => api.post<{ data: Diagram }>('/diagrams', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blueprint', 'diagrams'] }),
  });
}

export function useUpdateDiagram(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<Diagram>) => api.patch<{ data: Diagram }>(`/diagrams/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['blueprint', 'diagrams'] });
      qc.invalidateQueries({ queryKey: ['blueprint', 'diagrams', id] });
      qc.invalidateQueries({ queryKey: ['blueprint', 'diagrams', id, 'graph'] });
    },
  });
}

export function useArchiveDiagram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: { id: string; is_archived: boolean } }>(`/diagrams/${id}/archive`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blueprint', 'diagrams'] }),
  });
}

export function useStarDiagram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: { starred: boolean } }>(`/diagrams/${id}/star`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blueprint', 'diagrams'] }),
  });
}

export function useUnstarDiagram() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ data: { starred: boolean } }>(`/diagrams/${id}/star`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blueprint', 'diagrams'] }),
  });
}

export function useSnapshotVersion(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (label?: string | null) =>
      api.post<{ data: DiagramVersion }>(`/diagrams/${id}/versions`, { label: label ?? null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blueprint', 'diagrams', id, 'versions'] }),
  });
}

export function useRestoreVersion(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (versionNumber: number) =>
      api.post<{ data: DiagramGraph }>(`/diagrams/${id}/versions/${versionNumber}/restore`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['blueprint', 'diagrams', id] });
      qc.invalidateQueries({ queryKey: ['blueprint', 'diagrams', id, 'graph'] });
    },
  });
}
