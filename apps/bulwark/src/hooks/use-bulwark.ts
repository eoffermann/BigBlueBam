import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  BulwarkContract,
  BulwarkObligation,
  BulwarkNoticeDeadline,
  BulwarkWaiverRisk,
  BulwarkVendorTier,
  BulwarkComplianceDoc,
  BulwarkOrgSettings,
  BulwarkPatchObligationInput,
  BulwarkUpdateContractInput,
  BulwarkCreateVendorTierInput,
} from '@bigbluebam/shared';

// ---------------------------------------------------------------------------
// Typed Bulwark API client (apps/bulwark-api routes, spec section 5.1). Request
// and response shapes come from @bigbluebam/shared bulwark schemas (single
// source of truth) as `import type`, so no zod runtime is pulled into the SPA.
// Shapes the API composes but the shared package does not name (contract rollup,
// draft/discharge/chase result envelopes) are declared locally.
// ---------------------------------------------------------------------------

export interface ListEnvelope<T> {
  data: T[];
  next_cursor?: string | null;
  total?: number;
}

export interface ObligationRollup {
  total: number;
  pending: number;
  armed: number;
}
export interface DeadlineRollup {
  open: number;
  missed: number;
}

export interface BulwarkContractDetail extends BulwarkContract {
  obligations: BulwarkObligation[];
  rollup: {
    obligations: ObligationRollup;
    deadlines: DeadlineRollup;
  };
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export interface ContractListFilter {
  status?: string;
  projectId?: string;
  cursor?: string;
  limit?: number;
}

export function useContracts(filter: ContractListFilter = {}) {
  return useQuery({
    queryKey: ['bulwark', 'contracts', filter],
    queryFn: () =>
      api.get<ListEnvelope<BulwarkContract>>('/contracts', {
        'filter[status]': filter.status,
        'filter[project_id]': filter.projectId,
        cursor: filter.cursor,
        limit: filter.limit,
      }),
  });
}

export function useContract(id: string | undefined) {
  return useQuery({
    queryKey: ['bulwark', 'contracts', id],
    queryFn: () => api.get<{ data: BulwarkContractDetail }>(`/contracts/${id}`),
    enabled: !!id,
  });
}

export function useContractObligations(id: string | undefined) {
  return useQuery({
    queryKey: ['bulwark', 'contracts', id, 'obligations'],
    queryFn: () => api.get<{ data: BulwarkObligation[] }>(`/contracts/${id}/obligations`),
    enabled: !!id,
  });
}

export function useUpdateContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: BulwarkUpdateContractInput }) =>
      api.patch<{ data: BulwarkContract }>(`/contracts/${id}`, input),
    onSuccess: (_res, vars) => {
      qc.invalidateQueries({ queryKey: ['bulwark', 'contracts'] });
      qc.invalidateQueries({ queryKey: ['bulwark', 'contracts', vars.id] });
    },
  });
}

export function useReExtract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: BulwarkContract }>(`/contracts/${id}/extract`),
    onSuccess: (_res, id) => {
      qc.invalidateQueries({ queryKey: ['bulwark', 'contracts', id] });
    },
  });
}

export function useDeleteContract() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<{ data: { deleted: boolean; id: string } }>(`/contracts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bulwark', 'contracts'] }),
  });
}

// ---------------------------------------------------------------------------
// Obligations (the ledger)
// ---------------------------------------------------------------------------

export interface ObligationListFilter {
  reviewStatus?: string;
  obligationType?: string;
  contractId?: string;
  sortByConfidenceDesc?: boolean;
  cursor?: string;
  limit?: number;
}

export function useObligations(filter: ObligationListFilter = {}) {
  return useQuery({
    queryKey: ['bulwark', 'obligations', filter],
    queryFn: () =>
      api.get<ListEnvelope<BulwarkObligation>>('/obligations', {
        'filter[review_status]': filter.reviewStatus,
        'filter[obligation_type]': filter.obligationType,
        'filter[contract_id]': filter.contractId,
        sort: filter.sortByConfidenceDesc ? '-confidence' : undefined,
        cursor: filter.cursor,
        limit: filter.limit,
      }),
  });
}

export function useObligation(id: string | undefined) {
  return useQuery({
    queryKey: ['bulwark', 'obligations', id],
    queryFn: () => api.get<{ data: BulwarkObligation }>(`/obligations/${id}`),
    enabled: !!id,
  });
}

function invalidateLedger(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['bulwark', 'obligations'] });
  qc.invalidateQueries({ queryKey: ['bulwark', 'contracts'] });
}

// Confirm / edit / bind-to-base / reject an extracted obligation.
export function usePatchObligation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: BulwarkPatchObligationInput }) =>
      api.patch<{ data: BulwarkObligation }>(`/obligations/${id}`, input),
    onSuccess: () => invalidateLedger(qc),
  });
}

// Manual trigger ("this happened, start the clock").
export function useTriggerObligation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, occurredAt }: { id: string; occurredAt: string }) =>
      api.post<{ data: BulwarkNoticeDeadline }>(`/obligations/${id}/trigger`, { occurred_at: occurredAt }),
    onSuccess: () => {
      invalidateLedger(qc);
      qc.invalidateQueries({ queryKey: ['bulwark', 'deadlines'] });
    },
  });
}

// ---------------------------------------------------------------------------
// Deadline radar
// ---------------------------------------------------------------------------

export interface DeadlineListFilter {
  status?: string;
  contractId?: string;
  projectId?: string;
  dueBefore?: string;
  cursor?: string;
  limit?: number;
}

export function useDeadlines(filter: DeadlineListFilter = {}) {
  return useQuery({
    queryKey: ['bulwark', 'deadlines', filter],
    queryFn: () =>
      api.get<ListEnvelope<BulwarkNoticeDeadline>>('/deadlines', {
        'filter[status]': filter.status,
        'filter[contract_id]': filter.contractId,
        'filter[project_id]': filter.projectId,
        'filter[due_before]': filter.dueBefore,
        cursor: filter.cursor,
        limit: filter.limit,
      }),
  });
}

export function useDeadline(id: string | undefined) {
  return useQuery({
    queryKey: ['bulwark', 'deadlines', id],
    queryFn: () => api.get<{ data: BulwarkNoticeDeadline }>(`/deadlines/${id}`),
    enabled: !!id,
  });
}

function invalidateRadar(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['bulwark', 'deadlines'] });
  qc.invalidateQueries({ queryKey: ['bulwark', 'waiver-risks'] });
}

export function useDraftNotice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: BulwarkNoticeDeadline }>(`/deadlines/${id}/draft-notice`),
    onSuccess: () => invalidateRadar(qc),
  });
}

export function useApproveSendNotice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: BulwarkNoticeDeadline }>(`/deadlines/${id}/approve-send`),
    onSuccess: () => invalidateRadar(qc),
  });
}

// Discard a bad notice DRAFT (#47): rejects the generated text without touching the deadline
// clock. Distinct from useDischargeDeadline({ outcome: 'waived' }), which forgoes the obligation.
export function useDiscardNotice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: { discarded: boolean; notice_status: string } }>(
        `/deadlines/${id}/discard-notice`,
      ),
    onSuccess: () => invalidateRadar(qc),
  });
}

export interface DischargeInput {
  outcome: 'discharged' | 'waived';
  confirm?: boolean;
  reason?: string;
}

export function useDischargeDeadline() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: DischargeInput }) =>
      api.post<{ data: BulwarkNoticeDeadline }>(`/deadlines/${id}/discharge`, input),
    onSuccess: () => invalidateRadar(qc),
  });
}

// ---------------------------------------------------------------------------
// Waiver risks
// ---------------------------------------------------------------------------

export interface WaiverRiskFilter {
  status?: string;
  contractId?: string;
  cursor?: string;
  limit?: number;
}

export function useWaiverRisks(filter: WaiverRiskFilter = {}) {
  return useQuery({
    queryKey: ['bulwark', 'waiver-risks', filter],
    queryFn: () =>
      api.get<ListEnvelope<BulwarkWaiverRisk>>('/waiver-risks', {
        'filter[status]': filter.status,
        'filter[contract_id]': filter.contractId,
        cursor: filter.cursor,
        limit: filter.limit,
      }),
  });
}

// ---------------------------------------------------------------------------
// Vendor tiers + compliance docs
// ---------------------------------------------------------------------------

export interface VendorTierFilter {
  contractId?: string;
  chaseStatus?: string;
}

export function useVendorTiers(filter: VendorTierFilter = {}) {
  return useQuery({
    queryKey: ['bulwark', 'vendor-tiers', filter],
    queryFn: () =>
      api.get<{ data: BulwarkVendorTier[] }>('/vendor-tiers', {
        'filter[contract_id]': filter.contractId,
        'filter[chase_status]': filter.chaseStatus,
      }),
  });
}

export function useCreateVendorTier() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BulwarkCreateVendorTierInput) =>
      api.post<{ data: BulwarkVendorTier }>('/vendor-tiers', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bulwark', 'vendor-tiers'] }),
  });
}

export interface ComplianceDocFilter {
  vendorTierId?: string;
  validityStatus?: string;
  docType?: string;
}

export function useComplianceDocs(filter: ComplianceDocFilter = {}) {
  return useQuery({
    queryKey: ['bulwark', 'compliance-docs', filter],
    queryFn: () =>
      api.get<{ data: BulwarkComplianceDoc[] }>('/compliance-docs', {
        'filter[vendor_tier_id]': filter.vendorTierId,
        'filter[validity_status]': filter.validityStatus,
        'filter[doc_type]': filter.docType,
      }),
  });
}

function invalidateCompliance(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['bulwark', 'compliance-docs'] });
  qc.invalidateQueries({ queryKey: ['bulwark', 'vendor-tiers'] });
}

export function useDraftChase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: BulwarkComplianceDoc }>(`/compliance-docs/${id}/chase`),
    onSuccess: () => invalidateCompliance(qc),
  });
}

export function useApproveSendChase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: BulwarkComplianceDoc }>(`/compliance-docs/${id}/approve-send`),
    onSuccess: () => invalidateCompliance(qc),
  });
}

// ---------------------------------------------------------------------------
// Org settings
// ---------------------------------------------------------------------------

export function useSettings() {
  return useQuery({
    queryKey: ['bulwark', 'settings'],
    queryFn: () => api.get<{ data: BulwarkOrgSettings }>('/settings'),
  });
}

export interface UpdateSettingsInput {
  default_timezone?: string;
  auto_confirm_threshold?: number;
  radar_lead_times?: { critical_hours: number; high_hours: number; medium_hours: number };
  auto_draft_notices?: boolean;
  auto_draft_max_per_sweep?: number;
  notice_llm_daily_cap?: number;
  chase_cadence_days?: number;
  coi_expiry_lead_days?: number;
  discharged_deadline_retention_days?: number;
  inbox_retention_days?: number;
  llm_provider_id?: string | null;
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSettingsInput) =>
      api.patch<{ data: BulwarkOrgSettings }>('/settings', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bulwark', 'settings'] }),
  });
}
