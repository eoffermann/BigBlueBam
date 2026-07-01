import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ---------------------------------------------------------------------------
// Asset types (mirror apps/bin-api/src/services/asset.service.ts)
// ---------------------------------------------------------------------------

export type ScanStatus = 'pending' | 'clean' | 'infected' | 'error' | 'skipped';

export interface BinAsset {
  id: string;
  name: string;
  content_type: string | null;
  size: number | null;
  scan_status: ScanStatus;
  // Set when an admin/SuperUser has persistently cleared this file's scan
  // block (false-positive resolution) — servable to everyone regardless of
  // scan_status.
  scan_override_at?: string | null;
  folder_id: string | null;
  project_id: string | null;
  tags: string[];
  visibility?: string;
  current_version_id?: string | null;
  created_at: string;
  updated_at: string;
}

export function useAssets(params?: { folder_id?: string; project_id?: string; tag?: string }) {
  return useQuery({
    queryKey: ['bin', 'assets', params],
    queryFn: () => api.get<{ data: BinAsset[] }>('/v1/assets', params),
  });
}

// ---------------------------------------------------------------------------
// Folders (mirror apps/bin-api folder routes). The API returns every folder in
// the org as a flat list; callers build the tree client-side from parent_id.
// ---------------------------------------------------------------------------

export interface BinFolder {
  id: string;
  org_id: string;
  project_id: string | null;
  parent_id: string | null;
  name: string;
  created_at: string;
}

export function useFolders() {
  return useQuery({
    queryKey: ['bin', 'folders'],
    queryFn: () => api.get<{ data: BinFolder[] }>('/v1/folders'),
  });
}

export function useCreateFolder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; parent_id?: string | null; project_id?: string | null }) =>
      api.post<{ data: BinFolder }>('/v1/folders', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bin', 'folders'] });
    },
  });
}

// Distinct tags across the org, for the tag-filter chips.
export function useTags() {
  return useQuery({
    queryKey: ['bin', 'tags'],
    queryFn: () => api.get<{ data: string[] }>('/v1/tags'),
  });
}

// Patch an asset's name, folder (move), or tags (retag). folder_id:null moves
// the asset to root (unfiled). Refetches assets + tags so chips stay in sync.
export interface AssetPatch {
  name?: string;
  folder_id?: string | null;
  tags?: string[];
}

export function useUpdateAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: AssetPatch }) =>
      api.patch<{ data: BinAsset }>(`/v1/assets/${id}`, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bin', 'assets'] });
      qc.invalidateQueries({ queryKey: ['bin', 'tags'] });
    },
  });
}

// Upload a brand-new asset: create the metadata row, then stream the bytes
// (proxied multipart). The new version lands scan_status='pending' until the AV
// sweep clears it (~1 min); the list refetches so the badge updates.
export function useUploadAsset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const created = await api.post<{ data: BinAsset }>('/v1/assets', {
        name: file.name,
        content_type: file.type || 'application/octet-stream',
      });
      const id = created.data.id;
      await api.upload<{ data: unknown }>(`/v1/assets/${id}/upload`, file);
      return created.data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bin', 'assets'] });
    },
  });
}

// Hard-delete assets (row + bytes). Returns per-id results; a missing/
// already-deleted id is reported, not thrown. Invalidates the library + tags.
export interface DeleteAssetResult {
  id: string;
  deleted: boolean;
  storage_removed: number;
  storage_missing: number;
  error?: string;
}

export function useDeleteAssets() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      api.post<{ data: DeleteAssetResult[] }>('/v1/assets/bulk-delete', { ids }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bin', 'assets'] });
      qc.invalidateQueries({ queryKey: ['bin', 'tags'] });
      qc.invalidateQueries({ queryKey: ['bin', 'scan-overview'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Scan progress + policy + per-file override
// ---------------------------------------------------------------------------

export interface ScanOverview {
  counts: { pending: number; clean: number; infected: number; error: number; skipped: number };
  scan_mode: string;
  allow_unscanned_access: boolean;
  oldest_pending_age_sec: number | null;
  recent_errors: { id: string; name: string; updated_at: string | null }[];
  can_override: boolean;
}

// Poll scan progress so the badge/strip stay live while a sweep runs. 8s is
// well under the ~1-min sweep cadence without hammering the API.
export function useScanOverview() {
  return useQuery({
    queryKey: ['bin', 'scan-overview'],
    queryFn: () => api.get<{ data: ScanOverview }>('/v1/scan/overview'),
    refetchInterval: 8000,
  });
}

// Admin/SuperUser: set (or clear with null) the org's "allow work before scan
// completes" override. Returns the refreshed overview.
export function useSetScanPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (allow_unscanned_access: boolean | null) =>
      api.put<{ data: ScanOverview }>('/v1/scan/policy', { allow_unscanned_access }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bin', 'scan-overview'] });
    },
  });
}

// Admin/SuperUser: persistently override (allow:true) or clear (allow:false) a
// single file's scan block. Refreshes the library so the badge/download update.
export function useScanOverride() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, allow, reason }: { id: string; allow: boolean; reason?: string }) =>
      api.post<{ data: unknown }>(`/v1/assets/${id}/scan-override`, { allow, reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bin', 'assets'] });
      qc.invalidateQueries({ queryKey: ['bin', 'scan-overview'] });
    },
  });
}

export function useAsset(id: string | undefined) {
  return useQuery({
    queryKey: ['bin', 'assets', id],
    queryFn: () => api.get<{ data: BinAsset }>(`/v1/assets/${id}`),
    enabled: !!id,
  });
}

// ---------------------------------------------------------------------------
// Structured-data types (mirror apps/bin-api/src/services/data.service.ts +
// @bigbluebam/structured-data InferredSchema)
// ---------------------------------------------------------------------------

export interface InferredField {
  key: string;
  type: string;
  nullable?: boolean;
  enumValues?: string[];
}

export interface InferredSchema {
  fields: InferredField[];
}

export interface RecordData {
  shape: 'record';
  dialect: unknown;
  columns: string[];
  rows: Record<string, unknown>[];
  total: number;
  offset: number;
  limit: number;
  schema: InferredSchema;
}

export interface TreeData {
  shape: 'tree';
  dialect: unknown;
  data: unknown;
}

export type StructuredData = RecordData | TreeData;

export function useData(assetId: string | undefined) {
  return useQuery({
    queryKey: ['bin', 'data', assetId],
    queryFn: () => api.get<{ data: StructuredData }>(`/v1/data/${assetId}`),
    enabled: !!assetId,
    // Servability (409) and unsupported-format (422) are deterministic outcomes,
    // not transient — don't burn a retry on them.
    retry: false,
  });
}

// A single-cell patch: set one column on the row at `index` (0-based in the
// current order). Each commit mints a new immutable version server-side, so we
// refetch the data on success.
export interface RowPatch {
  index: number;
  set: Record<string, unknown>;
}

export function usePatchRows(assetId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patches: RowPatch[]) =>
      api.patch<{ data: unknown }>(`/v1/data/${assetId}/rows`, { patches }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bin', 'data', assetId] });
      qc.invalidateQueries({ queryKey: ['bin', 'assets', assetId] });
    },
  });
}

// A value-set patch on a tree-shaped asset: set the value at a path
// (e.g. ["passengers", 2, "vip"]). Commits a new immutable version server-side.
export interface TreePatch {
  path: (string | number)[];
  value: unknown;
}

export function usePatchTree(assetId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patches: TreePatch[]) =>
      api.patch<{ data: unknown }>(`/v1/data/${assetId}/tree`, { patches }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bin', 'data', assetId] });
      qc.invalidateQueries({ queryKey: ['bin', 'assets', assetId] });
    },
  });
}

// Add/delete a row in any grid. path omitted/[] = a record asset's top-level
// rows; a path like ["passengers"] = a tree embedded grid. Commits a new version.
export interface ArrayOp {
  op: 'append' | 'insert' | 'delete';
  path?: (string | number)[];
  value?: unknown;
  index?: number;
}

export function useArrayOp(assetId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (op: ArrayOp) => api.post<{ data: unknown }>(`/v1/data/${assetId}/array`, op),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['bin', 'data', assetId] });
      qc.invalidateQueries({ queryKey: ['bin', 'assets', assetId] });
    },
  });
}
