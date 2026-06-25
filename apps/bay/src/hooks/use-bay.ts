import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ---------------------------------------------------------------------------
// Asset types (mirror apps/bay-api review-asset model)
// ---------------------------------------------------------------------------

export type MediaKind = 'image' | 'video' | 'audio' | 'model';

export interface BayAsset {
  id: string;
  name: string;
  media_kind: MediaKind;
  current_version_id: string | null;
  project_id: string | null;
  created_at: string;
  archived_at: string | null;
}

export function useAssets(params?: { project_id?: string }) {
  return useQuery({
    queryKey: ['bay', 'assets', params],
    queryFn: () => api.get<{ data: BayAsset[] }>('/v1/assets', params),
  });
}

export function useAsset(id: string | undefined) {
  return useQuery({
    queryKey: ['bay', 'assets', id],
    queryFn: () => api.get<{ data: BayAsset }>(`/v1/assets/${id}`),
    enabled: !!id,
  });
}

export interface CreateAssetInput {
  name: string;
  media_kind: MediaKind;
  project_id?: string;
}

export function useCreateAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAssetInput) => api.post<{ data: BayAsset }>('/v1/assets', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bay', 'assets'] });
    },
  });
}

export function useArchiveAsset(id: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ data: BayAsset }>(`/v1/assets/${id}/archive`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bay', 'assets'] });
      qc.invalidateQueries({ queryKey: ['bay', 'assets', id] });
    },
  });
}

// ---------------------------------------------------------------------------
// Version types
// ---------------------------------------------------------------------------

export interface MediaMeta {
  width?: number;
  height?: number;
  duration_sec?: number;
  codec?: string;
  [key: string]: unknown;
}

export interface BayVersion {
  id: string;
  asset_id: string;
  version_number: number;
  bin_asset_id: string | null;
  bin_version_id: string | null;
  media_meta: MediaMeta | null;
  created_at: string;
}

export function useVersions(assetId: string | undefined) {
  return useQuery({
    queryKey: ['bay', 'versions', assetId],
    queryFn: () => api.get<{ data: BayVersion[] }>(`/v1/assets/${assetId}/versions`),
    enabled: !!assetId,
  });
}

export function useVersion(id: string | undefined) {
  return useQuery({
    queryKey: ['bay', 'version', id],
    queryFn: () => api.get<{ data: BayVersion }>(`/v1/versions/${id}`),
    enabled: !!id,
  });
}

export interface CreateVersionInput {
  bin_asset_id?: string;
  bin_version_id?: string;
  media_meta?: MediaMeta;
}

export function useCreateVersion(assetId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateVersionInput) =>
      api.post<{ data: BayVersion }>(`/v1/assets/${assetId}/versions`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bay', 'versions', assetId] });
      qc.invalidateQueries({ queryKey: ['bay', 'assets', assetId] });
    },
  });
}

// ---------------------------------------------------------------------------
// Annotation types
// ---------------------------------------------------------------------------

export type AnchorType = 'frame' | 'timerange' | 'region' | 'viewpoint';

export interface FrameAnchor {
  type: 'frame';
  frame: number;
}

export interface TimerangeAnchor {
  type: 'timerange';
  start_sec: number;
  end_sec: number;
}

export interface RegionAnchor {
  type: 'region';
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ViewpointAnchor {
  type: 'viewpoint';
  camera?: string;
  [key: string]: unknown;
}

export type Anchor = FrameAnchor | TimerangeAnchor | RegionAnchor | ViewpointAnchor;

export interface BayAnnotation {
  id: string;
  version_id: string;
  author_id: string;
  anchor: Anchor;
  body: string;
  resolved: boolean;
  created_at: string;
  thread_parent_id?: string | null;
}

export function useAnnotations(versionId: string | undefined, includeResolved: boolean) {
  return useQuery({
    queryKey: ['bay', 'annotations', versionId, includeResolved],
    queryFn: () =>
      api.get<{ data: BayAnnotation[] }>(`/v1/versions/${versionId}/annotations`, {
        include_resolved: includeResolved ? 'true' : undefined,
      }),
    enabled: !!versionId,
  });
}

export interface CreateAnnotationInput {
  anchor: Anchor;
  body: string;
  thread_parent_id?: string;
}

export function useCreateAnnotation(versionId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateAnnotationInput) =>
      api.post<{ data: BayAnnotation }>(`/v1/versions/${versionId}/annotations`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bay', 'annotations', versionId] });
    },
  });
}

export function useResolveAnnotation(versionId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, resolved }: { id: string; resolved: boolean }) =>
      api.post<{ data: BayAnnotation }>(`/v1/annotations/${id}/resolve`, { resolved }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bay', 'annotations', versionId] });
    },
  });
}

// ---------------------------------------------------------------------------
// Decision types
// ---------------------------------------------------------------------------

export type DecisionValue = 'approved' | 'rejected' | 'changes_requested' | 'pending';

export interface BayDecision {
  id: string;
  version_id: string;
  reviewer_id: string;
  decision: DecisionValue;
  comment: string | null;
  created_at: string;
}

export function useDecisions(versionId: string | undefined) {
  return useQuery({
    queryKey: ['bay', 'decisions', versionId],
    queryFn: () => api.get<{ data: BayDecision[] }>(`/v1/versions/${versionId}/decisions`),
    enabled: !!versionId,
  });
}

export interface SetDecisionInput {
  decision: DecisionValue;
  comment?: string;
}

export function useSetDecision(versionId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SetDecisionInput) =>
      api.put<{ data: BayDecision }>(`/v1/versions/${versionId}/decision`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bay', 'decisions', versionId] });
    },
  });
}
