import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  BurnMoneyBlock,
  BurnEngagementCreate,
  BurnEngagementUpdate,
  BurnDeliverableUpdate,
  BurnConfirmEnvelope,
  BurnAttributionCreate,
  BurnAttributionUpdate,
  BurnAttributionBulk,
  BurnBulkResult,
  BurnRuleCreate,
  BurnRuleUpdate,
  BurnPrecheckRequest,
  BurnPrecheckResponse,
  BurnPrecheckOverride,
  BurnPrecheckLabel,
  BurnVarianceUpdate,
  BurnChangeOrderDraft,
  BurnCostRateCreate,
  BurnSettingsUpdate,
} from '@bigbluebam/shared';

// ---------------------------------------------------------------------------
// Typed Burn API client (apps/burn-api routes under /v1, spec section 6.1).
// Enum/DTO shapes come from @bigbluebam/shared (single source of truth) as
// `import type`; the DB-row response shapes the service composes but the shared
// package does not export are declared locally, mirroring the burn-api service
// return types. numeric() columns serialize as STRINGS; bigint money as numbers.
// Every money-bearing field is read_all-floored server-side: it is DELETED
// (absent), not nulled, for callers without burn.financials.read_all.
// ---------------------------------------------------------------------------

export interface CursorEnvelope<T> {
  data: T[];
  next_cursor: string | null;
  hidden_by_permissions?: number;
}
export interface PlainEnvelope<T> {
  data: T[];
}

export interface EngagementRow {
  id: string;
  organization_id: string;
  title: string;
  engagement_kind: string;
  amends_engagement_id: string | null;
  supersedes_engagement_id: string | null;
  chain_root_id: string;
  contract_value?: number | null;
  contract_value_delta?: number | null;
  currency: string;
  envelope_basis: string;
  period_length_days: number | null;
  budget_hours: string | null;
  bin_asset_id: string | null;
  account_type: string | null;
  account_id: string | null;
  braid_profile_id: string | null;
  bill_client_id: string | null;
  start_date: string | null;
  end_date: string | null;
  timezone: string;
  status: string;
  extraction_status: string;
  source_doc_hash: string | null;
  extracted_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface RollupRow {
  id: string;
  chain_root_id: string;
  contract_value?: number | null;
  attributed_billable?: number | null;
  attributed_cost?: number | null;
  unscoped_sold_by_nobody?: number | null;
  unscoped_unclassified?: number | null;
  unscoped_outside_contract?: number | null;
  pending_review_amount?: number | null;
  awaiting_valuation_amount?: number | null;
  non_billable_amount?: number | null;
  consumption_pct: string | null;
  margin_amount?: number | null;
  margin_pct?: string | null;
  cost_rate_coverage_pct?: string | null;
  priced_deliverable_coverage_pct: string | null;
  distinct_contributor_count: number;
  metric_basis: string;
  revenue_basis: string;
  period_start: string | null;
  period_end: string | null;
  period_index: number | null;
  margin_state: string | null;
  work_item_count: number;
  frozen_at: string | null;
  computed_at: string;
}

export interface EngagementDetail extends EngagementRow {
  project_ids: string[];
  rollup: RollupRow | null;
  hidden_by_permissions: number;
}

export interface BurndownStepUp {
  at: string | null;
  kind: 'engagement' | 'deliverable';
  engagement_id?: string;
  deliverable_id?: string;
  contract_value?: number | null;
  contract_value_delta?: number | null;
  envelope_amount?: number | null;
  envelope_amount_delta?: number | null;
}
export interface BurndownPoint {
  at: string;
  // A basis-aware discriminated money block (suppressed for a member; figures for read_all),
  // built server-side by buildMoneyBlock. Never a bare cost or a bare percentage.
  money: BurnMoneyBlock;
}
export interface Burndown {
  chain_root_id: string;
  currency: string;
  step_ups: BurndownStepUp[];
  as_of: string;
  // Chain-level money block for the surface as a whole (same discriminated union).
  money: BurnMoneyBlock;
  points: BurndownPoint[];
}

export interface ChainFinancials {
  chain_root_id: string;
  engagement_id: string;
  title: string;
  money: BurnMoneyBlock;
  final: boolean;
  stale: boolean;
}
export interface AccountGroup {
  account_key: string;
  account_type: string | null;
  chain_count: number;
  money: BurnMoneyBlock;
}

export interface DeliverableRow {
  id: string;
  engagement_id: string;
  clause_ref: string | null;
  title: string;
  description?: string | null;
  deliverable_kind: string;
  amends_deliverable_id: string | null;
  envelope_amount_delta?: number | null;
  envelope_amount?: number | null;
  envelope_hours: string | null;
  envelope_source: string;
  lifecycle_status: string;
  cited_span: { quote?: string | null; clause_ref?: string | null; page?: number | null } | null;
  due_date: string | null;
  confidence: string | null;
  review_status: string;
  is_active: boolean;
  supersedes_deliverable_id: string | null;
  envelope_confirmed_by: string | null;
  envelope_confirmed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface WorkItemRow {
  id: string;
  source_type: string;
  source_id: string;
  project_id: string | null;
  actor_id: string | null;
  occurred_at: string;
  ingested_at: string;
  title_snapshot: string | null;
  text_snapshot: string | null;
  minutes: number | null;
  billable_amount?: number | null;
  cost_amount?: number | null;
  currency: string | null;
  valuation_basis: string;
  unrated_reason: string | null;
  attribution_state: string;
  exclusion_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface AttributionRow {
  id: string;
  work_item_id: string;
  deliverable_id: string | null;
  engagement_id: string | null;
  chain_root_id: string | null;
  state: string;
  unscoped_reason: string | null;
  non_billable_reason: string | null;
  confidence: string | null;
  method: string;
  rationale: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
}
export type UnscopedRow = AttributionRow & {
  bucket: 'sold_by_nobody' | 'unclassified' | 'outside_contract';
  work_item: WorkItemRow;
};
export type AttributionWithItem = AttributionRow & { work_item: WorkItemRow };

export interface QueueHealth {
  unscoped_sold_by_nobody: number;
  unscoped_unclassified: number;
  unscoped_outside_contract: number;
  pending_review_amount: number;
  pending_review_count: number;
  awaiting_valuation_amount: number;
  awaiting_valuation_count: number;
  oldest_unscoped_at: string | null;
  unscoped_alert_floor: number;
  statement: string;
}

export interface VarianceRow {
  id: string;
  engagement_id: string | null;
  chain_root_id: string | null;
  deliverable_id: string | null;
  variance_kind: string;
  severity: string;
  amount?: number | null;
  detail: { refs?: Array<{ entity_type: string; entity_id: string; label?: string }>; note?: string } | null;
  status: string;
  proposal_id: string | null;
  detected_at: string | null;
  resolved_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ChangeOrder {
  proposal_id: string;
  status: string;
  payload: unknown;
  engagement: { id: string; title: string; currency: string } | null;
  created_at: string;
}

export interface PrecheckRow {
  id: string;
  work_ref_type: string;
  work_ref_id: string | null;
  project_id: string | null;
  proposed_amount: number | null;
  currency: string | null;
  engagement_id: string | null;
  deliverable_id: string | null;
  verdict: string;
  verdict_reason: string;
  mode_at_decision: string;
  enforced: boolean;
  is_calibrating: boolean;
  envelope_amount?: number | null;
  envelope_consumed?: number | null;
  envelope_remaining?: number | null;
  overage_amount?: number | null;
  confidence: string | null;
  outcome: string;
  advisory_feedback: string | null;
  override_reason_code: string | null;
  override_reason_text: string | null;
  latency_ms: number | null;
  valid_until: string;
  created_at: string;
}

export interface CostRateRow {
  id: string;
  project_id: string | null;
  user_id: string | null;
  cost_amount: number;
  rate_type: string;
  currency: string;
  effective_from: string;
  effective_to: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface RuleRow {
  id: string;
  name: string;
  priority: number;
  match: Record<string, unknown>;
  outcome_kind: string;
  outcome_deliverable_id: string | null;
  outcome_reason: string | null;
  is_enabled: boolean;
  match_count: number;
  last_match_pct: string | null;
  created_at: string;
  updated_at: string;
}

export interface OrgSettings {
  organization_id: string;
  gate_mode: string;
  gate_enabled_refs: string[];
  gate_paused_until: string | null;
  deny_threshold: string;
  map_threshold: string;
  auto_attribute_threshold: string;
  review_threshold: string;
  pending_review_max_age_days: number;
  reconcile_window_days: number;
  overage_bucket_amount: number;
  min_contributors_for_cost_aggregate: number;
  match_ceiling_pct: string;
  unscoped_alert_floor: number;
  candidate_k: number;
  embedding_enabled: boolean;
  banter_signal_enabled: boolean;
  vcs_signal_enabled: boolean;
  llm_provider_id: string | null;
  work_item_retention_days: number;
  ingest_retention_days: number;
  gate_promoted_at: string | null;
  gate_demoted_at: string | null;
  updated_at: string;
}

export type CalibrationPreconditionKey =
  | 'volume'
  | 'soak'
  | 'labeled_denies'
  | 'precision'
  | 'gate_coverage'
  | 'priced_coverage'
  | 'acknowledgement';
export interface CalibrationPrecondition {
  key: CalibrationPreconditionKey;
  label: string;
  satisfied: boolean;
  actual: number | string | boolean | null;
  required: number | string | boolean | null;
  shortfall: string | null;
}
export interface Calibration {
  gate_mode: string;
  eligible_for_blocking: boolean;
  preconditions: CalibrationPrecondition[];
  gate_coverage_pct: number | null;
  gate_unavailable_days: number;
  gate_not_configured_days: number;
  coverage_window_days?: number;
}

const key = (...parts: unknown[]) => ['burn', ...parts];

// ---------------------------------------------------------------------------
// Engagements + Portfolio Board
// ---------------------------------------------------------------------------

export function useEngagements(filter: { status?: string; accountId?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: key('engagements', filter),
    queryFn: () =>
      api.get<CursorEnvelope<EngagementRow>>('/engagements', {
        'filter[status]': filter.status,
        'filter[account_id]': filter.accountId,
        limit: filter.limit ?? 100,
      }),
  });
}

export function useEngagement(id: string | undefined) {
  return useQuery({
    queryKey: key('engagements', id),
    queryFn: () => api.get<{ data: EngagementDetail }>(`/engagements/${id}`),
    enabled: !!id,
  });
}

export function useBurndown(id: string | undefined) {
  return useQuery({
    queryKey: key('engagements', id, 'burndown'),
    queryFn: () => api.get<{ data: Burndown }>(`/engagements/${id}/burndown`),
    enabled: !!id,
  });
}

export function useCreateEngagement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BurnEngagementCreate) => api.post<{ data: EngagementRow }>('/engagements', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: key('engagements') }),
  });
}

export function useUpdateEngagement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: BurnEngagementUpdate }) =>
      api.patch<{ data: EngagementRow }>(`/engagements/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: key('engagements') }),
  });
}

export function useDeleteEngagement() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/engagements/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key('engagements') }),
  });
}

export function useExtractDeliverables() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: { engagement_id: string; status: string; queue: string } }>(
        `/engagements/${id}/extract`,
      ),
    onSuccess: (_r, id) => qc.invalidateQueries({ queryKey: key('engagements', id) }),
  });
}

// ---------------------------------------------------------------------------
// Financials
// ---------------------------------------------------------------------------

export function useChainFinancials(engagementId: string | undefined) {
  return useQuery({
    queryKey: key('financials', engagementId),
    queryFn: () => api.get<{ data: ChainFinancials }>('/financials', { engagement_id: engagementId }),
    enabled: !!engagementId,
  });
}

export function useAccountFinancials(enabled: boolean) {
  return useQuery({
    queryKey: key('financials', 'accounts'),
    queryFn: () => api.get<{ data: AccountGroup[] }>('/financials/accounts'),
    enabled,
    retry: false,
  });
}

// ---------------------------------------------------------------------------
// Deliverables
// ---------------------------------------------------------------------------

export function useDeliverables(
  filter: { engagementId?: string; reviewStatus?: string; lifecycleStatus?: string; q?: string; limit?: number } = {},
) {
  return useQuery({
    queryKey: key('deliverables', filter),
    queryFn: () =>
      api.get<CursorEnvelope<DeliverableRow>>('/deliverables', {
        'filter[engagement_id]': filter.engagementId,
        'filter[review_status]': filter.reviewStatus,
        'filter[lifecycle_status]': filter.lifecycleStatus,
        'filter[q]': filter.q,
        limit: filter.limit ?? 100,
      }),
    enabled: filter.engagementId ? !!filter.engagementId : true,
  });
}

function invalidateDeliverables(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: key('deliverables') });
  qc.invalidateQueries({ queryKey: key('engagements') });
}

export function useUpdateDeliverable() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: BurnDeliverableUpdate }) =>
      api.patch<{ data: DeliverableRow }>(`/deliverables/${id}`, input),
    onSuccess: () => invalidateDeliverables(qc),
  });
}

export interface ConfirmEnvelopeResult {
  data: DeliverableRow;
  mode: 'applied' | 'proposed';
  proposal_id?: string;
}
export function useConfirmEnvelope() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: BurnConfirmEnvelope }) =>
      api.post<ConfirmEnvelopeResult>(`/deliverables/${id}/confirm-envelope`, input),
    onSuccess: () => invalidateDeliverables(qc),
  });
}

export function useBulkConfirmUnpriced() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deliverable_ids: string[]) =>
      api.post<{ data: { confirmed: number; deliverable_ids: string[] } }>(
        '/deliverables/bulk-confirm-unpriced',
        { deliverable_ids },
      ),
    onSuccess: () => invalidateDeliverables(qc),
  });
}

// ---------------------------------------------------------------------------
// Ledger: work items, unscoped queue, attributions
// ---------------------------------------------------------------------------

export function useWorkItems(
  filter: { attributionState?: string; projectId?: string; sourceType?: string; limit?: number } = {},
) {
  return useQuery({
    queryKey: key('work-items', filter),
    queryFn: () =>
      api.get<CursorEnvelope<WorkItemRow>>('/work-items', {
        'filter[attribution_state]': filter.attributionState,
        'filter[project_id]': filter.projectId,
        'filter[source_type]': filter.sourceType,
        limit: filter.limit ?? 100,
      }),
  });
}

export function useUnscoped(bucket: string | undefined, limit = 100) {
  return useQuery({
    queryKey: key('unscoped', bucket ?? 'all'),
    queryFn: () =>
      api.get<CursorEnvelope<UnscopedRow>>('/unscoped', { 'filter[bucket]': bucket, limit }),
  });
}

export function useQueueHealth() {
  return useQuery({
    queryKey: key('queue-health'),
    queryFn: () => api.get<{ data: QueueHealth }>('/queue-health'),
  });
}

export function useAttributions(filter: { state?: string; deliverableId?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: key('attributions', filter),
    queryFn: () =>
      api.get<CursorEnvelope<AttributionWithItem>>('/attributions', {
        'filter[state]': filter.state,
        'filter[deliverable_id]': filter.deliverableId,
        limit: filter.limit ?? 100,
      }),
  });
}

function invalidateLedger(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: key('unscoped') });
  qc.invalidateQueries({ queryKey: key('work-items') });
  qc.invalidateQueries({ queryKey: key('attributions') });
  qc.invalidateQueries({ queryKey: key('queue-health') });
}

export function useCreateAttribution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BurnAttributionCreate) => api.post<{ data: AttributionRow }>('/attributions', input),
    onSuccess: () => invalidateLedger(qc),
  });
}

export function useUpdateAttribution() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: BurnAttributionUpdate }) =>
      api.patch<{ data: AttributionRow }>(`/attributions/${id}`, input),
    onSuccess: () => invalidateLedger(qc),
  });
}

export function useBulkAttributions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BurnAttributionBulk) => api.post<BurnBulkResult>('/attributions/bulk', input),
    onSuccess: () => invalidateLedger(qc),
  });
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export function useRules() {
  return useQuery({
    queryKey: key('rules'),
    queryFn: () => api.get<PlainEnvelope<RuleRow>>('/rules'),
  });
}

export function useCreateRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BurnRuleCreate) => api.post<{ data: RuleRow }>('/rules', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: key('rules') }),
  });
}

export function useUpdateRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: BurnRuleUpdate }) =>
      api.patch<{ data: RuleRow }>(`/rules/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: key('rules') }),
  });
}

export function useDeleteRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/rules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key('rules') }),
  });
}

// ---------------------------------------------------------------------------
// Prechecks (gate console)
// ---------------------------------------------------------------------------

export function usePrechecks(filter: { verdict?: string; engagementId?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: key('prechecks', filter),
    queryFn: () =>
      api.get<CursorEnvelope<PrecheckRow>>('/prechecks', {
        'filter[verdict]': filter.verdict,
        'filter[engagement_id]': filter.engagementId,
        limit: filter.limit ?? 50,
      }),
  });
}

export function useRunPrecheck() {
  return useMutation({
    mutationFn: (input: BurnPrecheckRequest) => api.post<{ data: BurnPrecheckResponse }>('/precheck', input),
  });
}

export function useOverridePrecheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: BurnPrecheckOverride }) =>
      api.post<{ data: PrecheckRow }>(`/prechecks/${id}/override`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: key('prechecks') }),
  });
}

export function useLabelPrecheck() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: BurnPrecheckLabel }) =>
      api.post<{ data: PrecheckRow | { precheck_id: string; flagged: true } }>(
        `/prechecks/${id}/label`,
        input,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: key('prechecks') }),
  });
}

// ---------------------------------------------------------------------------
// Variances + change orders
// ---------------------------------------------------------------------------

export function useVariances(filter: { status?: string; kind?: string; engagementId?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: key('variances', filter),
    queryFn: () =>
      api.get<CursorEnvelope<VarianceRow>>('/variances', {
        'filter[status]': filter.status,
        'filter[kind]': filter.kind,
        'filter[engagement_id]': filter.engagementId,
        limit: filter.limit ?? 100,
      }),
  });
}

export function useUpdateVariance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: BurnVarianceUpdate }) =>
      api.patch<{ data: VarianceRow }>(`/variances/${id}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: key('variances') }),
  });
}

export function useDraftChangeOrder() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BurnChangeOrderDraft) =>
      api.post<{ data: { proposal_id: string; status: string; sent: false } }>('/change-orders', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: key('variances') }),
  });
}

export function useChangeOrder(id: string | undefined) {
  return useQuery({
    queryKey: key('change-orders', id),
    queryFn: () => api.get<{ data: ChangeOrder }>(`/change-orders/${id}`),
    enabled: !!id,
  });
}

// ---------------------------------------------------------------------------
// Cost rates
// ---------------------------------------------------------------------------

export function useCostRates(enabled: boolean, filter: { userId?: string; projectId?: string } = {}) {
  return useQuery({
    queryKey: key('cost-rates', filter),
    queryFn: () =>
      api.get<PlainEnvelope<CostRateRow>>('/cost-rates', {
        'filter[user_id]': filter.userId,
        'filter[project_id]': filter.projectId,
      }),
    enabled,
    retry: false,
  });
}

export function useCreateCostRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BurnCostRateCreate) =>
      api.post<{ data: CostRateRow; revalue_required: true }>('/cost-rates', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: key('cost-rates') }),
  });
}

export function useDeleteCostRate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/cost-rates/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key('cost-rates') }),
  });
}

// ---------------------------------------------------------------------------
// Settings + calibration
// ---------------------------------------------------------------------------

export function useSettings() {
  return useQuery({
    queryKey: key('settings'),
    queryFn: () => api.get<{ data: OrgSettings }>('/settings'),
  });
}

export function useCalibration() {
  return useQuery({
    queryKey: key('calibration'),
    queryFn: () => api.get<{ data: Calibration }>('/calibration'),
  });
}

export interface UpdateSettingsResult {
  data: OrgSettings;
}
export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BurnSettingsUpdate & { acknowledge_blocking?: boolean }) =>
      api.patch<UpdateSettingsResult>('/settings', input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: key('settings') });
      qc.invalidateQueries({ queryKey: key('calibration') });
    },
  });
}
