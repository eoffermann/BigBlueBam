import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type {
  BraidProfile,
  BraidIdentity,
  BraidCandidate,
  BraidSurvivorshipRule,
  BraidSettings,
  BraidSourceType,
  BraidResolveInput,
  BraidResolveResult,
} from '@bigbluebam/shared';

// ---------------------------------------------------------------------------
// Typed Braid API client (apps/braid-api spec section 5.1). Response/request
// shapes are imported from @bigbluebam/shared as `import type` (single source
// of truth, packages/shared/src/schemas/braid.ts) so no extra zod runtime is
// pulled into the SPA bundle. Shapes not yet promoted to the shared package
// (decisions, timeline) are declared locally below, matching section 5.1's
// prose description.
// ---------------------------------------------------------------------------

export type { BraidProfile, BraidIdentity, BraidCandidate, BraidSurvivorshipRule, BraidSettings, BraidSourceType };

export const BRAID_SOURCE_TYPES: BraidSourceType[] = [
  'bond.contact',
  'bond.company',
  'bill.client',
  'helpdesk.user',
  'book.event_attendee',
];

export const BRAID_SURVIVORSHIP_STRATEGIES = [
  'most_recent',
  'source_priority',
  'longest_non_null',
  'most_frequent',
  'manual_pin',
] as const;
export type BraidSurvivorshipStrategyT = (typeof BRAID_SURVIVORSHIP_STRATEGIES)[number];

export interface ListEnvelope<T> {
  data: T[];
  next_cursor?: string | null;
  total?: number;
}

// ---------------------------------------------------------------------------
// Decisions / audit history (spec 5.1 GET /profiles/:id/decisions)
// ---------------------------------------------------------------------------

export type BraidDecisionKindT = 'auto' | 'merge' | 'split' | 'reject';

export interface BraidDecision {
  id: string;
  profile_id: string;
  kind: BraidDecisionKindT;
  reason: string | null;
  affected_identity_ids: string[];
  absorbed_profile_id: string | null;
  actor_id?: string | null;
  actor_type?: string | null;
  created_at: string;
}

// ---------------------------------------------------------------------------
// Cross-app timeline (spec 5.1 GET /profiles/:id/timeline)
// ---------------------------------------------------------------------------

export interface BraidTimelineEntry {
  id: string;
  occurred_at: string;
  source_app?: string;
  source_type?: string;
  source_id?: string;
  actor_label?: string | null;
  event_type: string;
  summary: string;
  ref?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Golden profiles
// ---------------------------------------------------------------------------

export interface ProfileListFilter {
  kind?: 'person' | 'company';
  status?: 'active' | 'merged_away' | 'archived';
  q?: string;
  cursor?: string;
  limit?: number;
}

export function useProfiles(filter: ProfileListFilter) {
  return useQuery({
    queryKey: ['braid', 'profiles', filter],
    queryFn: () =>
      api.get<ListEnvelope<BraidProfile>>('/profiles', {
        'filter[kind]': filter.kind,
        'filter[status]': filter.status,
        q: filter.q,
        cursor: filter.cursor,
        limit: filter.limit,
      }),
  });
}

export function useProfile(id: string | undefined) {
  return useQuery({
    queryKey: ['braid', 'profiles', id],
    queryFn: () => api.get<{ data: BraidProfile }>(`/profiles/${id}`),
    enabled: !!id,
  });
}

export function useProfileIdentities(id: string | undefined) {
  return useQuery({
    queryKey: ['braid', 'profiles', id, 'identities'],
    queryFn: () => api.get<ListEnvelope<BraidIdentity>>(`/profiles/${id}/identities`),
    enabled: !!id,
  });
}

export function useProfileTimeline(id: string | undefined) {
  return useQuery({
    queryKey: ['braid', 'profiles', id, 'timeline'],
    queryFn: () => api.get<ListEnvelope<BraidTimelineEntry>>(`/profiles/${id}/timeline`),
    enabled: !!id,
  });
}

export function useProfileDecisions(id: string | undefined) {
  return useQuery({
    queryKey: ['braid', 'profiles', id, 'decisions'],
    queryFn: () => api.get<ListEnvelope<BraidDecision>>(`/profiles/${id}/decisions`),
    enabled: !!id,
  });
}

export function useResolve() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: BraidResolveInput) =>
      api.post<{ data: BraidResolveResult }>('/resolve', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['braid', 'profiles'] }),
  });
}

// ---------------------------------------------------------------------------
// Merge review queue (candidates)
// ---------------------------------------------------------------------------

export interface CandidateListFilter {
  status?: 'pending' | 'merged' | 'rejected' | 'superseded';
  cursor?: string;
  limit?: number;
}

export function useCandidates(filter: CandidateListFilter = {}) {
  return useQuery({
    queryKey: ['braid', 'candidates', filter],
    queryFn: () =>
      api.get<ListEnvelope<BraidCandidate>>('/candidates', {
        'filter[status]': filter.status ?? 'pending',
        cursor: filter.cursor,
        limit: filter.limit,
        sort: '-score',
      }),
  });
}

export function useCandidate(id: string | undefined) {
  return useQuery({
    queryKey: ['braid', 'candidates', id],
    queryFn: () => api.get<{ data: BraidCandidate }>(`/candidates/${id}`),
    enabled: !!id,
  });
}

function invalidateCandidateQueries(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['braid', 'candidates'] });
  qc.invalidateQueries({ queryKey: ['braid', 'profiles'] });
}

export function useMergeCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post<{ data: BraidCandidate }>(`/candidates/${id}/merge`, reason ? { reason } : undefined),
    onSuccess: () => invalidateCandidateQueries(qc),
  });
}

export function useRejectCandidate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, reason }: { id: string; reason?: string }) =>
      api.post<{ data: BraidCandidate }>(`/candidates/${id}/reject`, reason ? { reason } : undefined),
    onSuccess: () => invalidateCandidateQueries(qc),
  });
}

// ---------------------------------------------------------------------------
// Merge / split (truth-changing, HITL-gated)
// ---------------------------------------------------------------------------

export interface MergeProfilesInput {
  profile_a_id: string;
  profile_b_id: string;
  reason?: string;
}

export function useMergeProfiles() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: MergeProfilesInput) =>
      api.post<{ data: BraidProfile }>('/profiles/merge', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['braid', 'profiles'] }),
  });
}

export interface SplitProfileInput {
  merge_decision_id?: string;
  identity_ids?: string[];
  reason?: string;
}

export function useSplitProfile(profileId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: SplitProfileInput) =>
      api.post<{ data: BraidProfile }>(`/profiles/${profileId}/split`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['braid', 'profiles'] });
      qc.invalidateQueries({ queryKey: ['braid', 'profiles', profileId] });
    },
  });
}

// ---------------------------------------------------------------------------
// Survivorship rules
// ---------------------------------------------------------------------------

export function useSurvivorshipRules() {
  return useQuery({
    queryKey: ['braid', 'survivorship-rules'],
    queryFn: () => api.get<ListEnvelope<BraidSurvivorshipRule>>('/survivorship-rules'),
  });
}

export interface SetSurvivorshipRuleInput {
  strategy: BraidSurvivorshipStrategyT;
  source_priority?: BraidSourceType[];
  pinned_value?: unknown;
}

export function useSetSurvivorshipRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      kind,
      field,
      input,
    }: {
      kind: 'person' | 'company';
      field: string;
      input: SetSurvivorshipRuleInput;
    }) => api.put<{ data: BraidSurvivorshipRule }>(`/survivorship-rules/${kind}/${encodeURIComponent(field)}`, input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['braid', 'survivorship-rules'] }),
  });
}

// ---------------------------------------------------------------------------
// Org settings
// ---------------------------------------------------------------------------

export function useSettings() {
  return useQuery({
    queryKey: ['braid', 'settings'],
    queryFn: () => api.get<{ data: BraidSettings }>('/settings'),
  });
}

export interface UpdateSettingsInput {
  auto_merge_threshold?: number;
  review_threshold?: number;
  require_strong_signal_for_auto?: boolean;
  enabled_source_types?: BraidSourceType[];
  rescan_max_age_days?: number | null;
}

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSettingsInput) => api.patch<{ data: BraidSettings }>('/settings', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['braid', 'settings'] }),
  });
}
