import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ---------------------------------------------------------------------------
// Asset types (mirror apps/bin-api/src/services/asset.service.ts)
// ---------------------------------------------------------------------------

export type ScanStatus = 'pending' | 'clean' | 'infected' | 'skipped';

export interface BinAsset {
  id: string;
  name: string;
  content_type: string | null;
  size: number | null;
  scan_status: ScanStatus;
  folder_id: string | null;
  project_id: string | null;
  visibility?: string;
  current_version_id?: string | null;
  created_at: string;
  updated_at: string;
}

export function useAssets(params?: { folder_id?: string; project_id?: string }) {
  return useQuery({
    queryKey: ['bin', 'assets', params],
    queryFn: () => api.get<{ data: BinAsset[] }>('/v1/assets', params),
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
