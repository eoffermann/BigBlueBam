import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BursarCoverageOverride,
  BursarSettingsUpdate,
  BursarVendorCreate,
  BursarVendorUpdate,
  BursarRequestCreate,
} from '@bigbluebam/shared';
import {
  api,
  type AwardRow,
  type BaselineRow,
  type CoverageDetail,
  type CursorEnvelope,
  type DiffResponse,
  type DraftRow,
  type LibraryRow,
  type LevelingRunRow,
  type MatrixResponse,
  type MatrixTotal,
  type MismatchRow,
  type OrgSettingsRow,
  type PlainEnvelope,
  type RenewalRow,
  type RequestRow,
  type ReviewRow,
  type AliasRow,
  type SpendByVendorRow,
  type VendorRow,
} from '@/lib/api';

const key = (...parts: unknown[]) => ['bursar', ...parts];

// M7/M8 read surfaces may not be mounted yet. `retry: false` turns a 404 into a fast, quiet
// error the page renders as an empty state rather than a crash or an endless spinner.
const soft = { retry: false as const, staleTime: 15_000 };

/* ---------------------------------- Vendors --------------------------------- */

export function useVendors(status?: string) {
  return useQuery({
    queryKey: key('vendors', status ?? 'all'),
    queryFn: () => api.get<CursorEnvelope<VendorRow>>('/vendors', { 'filter[status]': status, limit: 200 }),
  });
}
export function useVendor(id: string | undefined) {
  return useQuery({
    queryKey: key('vendors', id),
    queryFn: () => api.get<{ data: VendorRow }>(`/vendors/${id}`),
    enabled: !!id,
  });
}
export function useVendorAliases(id: string | undefined) {
  return useQuery({
    queryKey: key('vendors', id, 'aliases'),
    queryFn: () => api.get<PlainEnvelope<AliasRow>>(`/vendors/${id}/aliases`),
    enabled: !!id,
    ...soft,
  });
}
export function useCreateVendor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BursarVendorCreate) => api.post<{ data: VendorRow }>('/vendors', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: key('vendors') }),
  });
}
export function useUpdateVendor() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: BursarVendorUpdate }) =>
      api.patch<{ data: VendorRow }>(`/vendors/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: key('vendors') }),
  });
}
export function useAliasReview() {
  return useQuery({
    queryKey: key('alias-review'),
    queryFn: () => api.get<PlainEnvelope<AliasRow>>('/vendors/alias-review'),
    ...soft,
  });
}

/* --------------------------------- Requests --------------------------------- */

export function useRequests(status?: string) {
  return useQuery({
    queryKey: key('requests', status ?? 'all'),
    queryFn: () => api.get<CursorEnvelope<RequestRow>>('/requests', { 'filter[status]': status, limit: 200 }),
  });
}
export function useRequest(id: string | undefined) {
  return useQuery({
    queryKey: key('requests', id),
    queryFn: () => api.get<{ data: RequestRow }>(`/requests/${id}`),
    enabled: !!id,
  });
}
export function useCreateRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BursarRequestCreate) => api.post<{ data: RequestRow }>('/requests', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: key('requests') }),
  });
}

/* ------------------------------ Leveling / diff ----------------------------- */

export function useMatrix(requestId: string | undefined) {
  return useQuery({
    queryKey: key('matrix', requestId),
    queryFn: () => api.get<MatrixResponse>(`/requests/${requestId}/matrix`),
    enabled: !!requestId,
    ...soft,
  });
}
export function useExclusionDiff(requestId: string | undefined) {
  return useQuery({
    queryKey: key('diff', requestId),
    queryFn: () => api.get<DiffResponse>(`/requests/${requestId}/exclusion-diff`),
    enabled: !!requestId,
    ...soft,
  });
}
export function useTotals(requestId: string | undefined) {
  return useQuery({
    queryKey: key('totals', requestId),
    queryFn: () => api.get<PlainEnvelope<MatrixTotal & { currency?: string }>>(`/requests/${requestId}/totals`),
    enabled: !!requestId,
    ...soft,
  });
}

/**
 * The AUTHORITATIVE progress source (spec 11.1). Polled at 5s while a run is live; the WS stream
 * is only an accelerant on top of this. `pollWhileLive` keeps the interval on until every run has
 * settled, then stops so a quiet request does not poll forever.
 */
export function useLevelingRuns(requestId: string | undefined, pollWhileLive = true) {
  return useQuery({
    queryKey: key('leveling-runs', requestId),
    queryFn: () => api.get<PlainEnvelope<LevelingRunRow>>(`/requests/${requestId}/leveling-runs`),
    enabled: !!requestId,
    refetchInterval: (q) => {
      if (!pollWhileLive) return false;
      const rows = q.state.data?.data ?? [];
      const live = rows.some((r) => r.status === 'running');
      return live ? 5000 : false;
    },
    ...soft,
  });
}

export function useStartLeveling(requestId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { run_id?: string; dry_run?: boolean } = {}) =>
      api.post<{ data: unknown }>(`/requests/${requestId}/level`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key('leveling-runs', requestId) });
      qc.invalidateQueries({ queryKey: key('matrix', requestId) });
    },
  });
}

export function useCoverageDetail(coverageId: string | undefined) {
  return useQuery({
    queryKey: key('coverage', coverageId),
    queryFn: () => api.get<{ data: CoverageDetail }>(`/coverage/${coverageId}`),
    enabled: !!coverageId,
    ...soft,
  });
}

export function useOverrideCoverage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: BursarCoverageOverride }) =>
      api.post<{ data: CoverageDetail }>(`/coverage/${id}/override`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key('review') });
      qc.invalidateQueries({ queryKey: key('matrix') });
      qc.invalidateQueries({ queryKey: key('diff') });
    },
  });
}

export function useReview() {
  return useQuery({
    queryKey: key('review'),
    queryFn: () => api.get<PlainEnvelope<ReviewRow>>('/review', { limit: 100 }),
    ...soft,
  });
}

/* --------------------------------- Settings --------------------------------- */

export function useSettings() {
  return useQuery({
    queryKey: key('settings'),
    queryFn: () => api.get<{ data: OrgSettingsRow }>('/settings'),
  });
}
export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BursarSettingsUpdate) =>
      api.patch<{ data: OrgSettingsRow; changed_fields: string[] }>('/settings', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: key('settings') }),
  });
}

/* --------- M7 / M8 surfaces (award, baseline, spend, mismatch, etc.) -------- */

export function useAwards(vendorId?: string) {
  return useQuery({
    queryKey: key('awards', vendorId ?? 'all'),
    queryFn: () => api.get<CursorEnvelope<AwardRow>>('/awards', { 'filter[vendor_id]': vendorId, limit: 100 }),
    ...soft,
  });
}
export function useBaseline(awardId: string | undefined) {
  return useQuery({
    queryKey: key('baseline', awardId),
    queryFn: () => api.get<{ data: BaselineRow }>(`/awards/${awardId}/baseline`),
    enabled: !!awardId,
    ...soft,
  });
}
export function useSpendByVendor(vendorId?: string) {
  return useQuery({
    queryKey: key('spend-by-vendor', vendorId ?? 'all'),
    queryFn: () =>
      api.get<PlainEnvelope<SpendByVendorRow>>('/spend/by-vendor', { 'filter[vendor_id]': vendorId }),
    ...soft,
  });
}
export function useMismatches(vendorId?: string, status?: string) {
  return useQuery({
    queryKey: key('mismatches', vendorId ?? 'all', status ?? 'open'),
    queryFn: () =>
      api.get<CursorEnvelope<MismatchRow>>('/mismatches', {
        'filter[vendor_id]': vendorId,
        'filter[status]': status,
        limit: 100,
      }),
    ...soft,
  });
}
export function useResolveMismatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'resolve' | 'dismiss' | 'mark-wrong' }) =>
      api.post<{ data: MismatchRow }>(`/mismatches/${id}/${action}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: key('mismatches') }),
  });
}
export function useRenewals() {
  return useQuery({
    queryKey: key('renewals'),
    queryFn: () => api.get<CursorEnvelope<RenewalRow>>('/renewals', { limit: 100 }),
    ...soft,
  });
}
export function useDrafts() {
  return useQuery({
    queryKey: key('drafts'),
    queryFn: () => api.get<CursorEnvelope<DraftRow>>('/drafts', { limit: 100 }),
    ...soft,
  });
}
export function useDecideDraft() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'reject' }) =>
      api.post<{ data: DraftRow }>(`/drafts/${id}/${action}`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: key('drafts') }),
  });
}
export function useLibrary() {
  return useQuery({
    queryKey: key('library'),
    queryFn: () => api.get<CursorEnvelope<LibraryRow>>('/library', { limit: 200 }),
    ...soft,
  });
}
