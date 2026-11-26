import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BastionBulkApplicability,
  BastionCompanyProfile,
  BastionExceptionPropose,
  BastionManualEvidenceCreate,
  BastionNotApplicableSuggestions,
  BastionTemplateKey,
} from '@bigbluebam/shared';
import {
  api,
  bamApi,
  type AssertionRow,
  type ControlDetail,
  type ControlsResponse,
  type DriftRow,
  type EvidenceSnapshotRow,
  type ExceptionRow,
  type FixDraftRow,
  type GapsResponse,
  type CoverageResponse,
  type EvidenceItem,
  type EvidenceListResponse,
  type FeedKeyRow,
  type FeedRow,
  type MintedKey,
  type MyAttestationRow,
  type PolicyAttestations,
  type PolicyAudience,
  type PolicyBody,
  type PolicyRow,
  type SummaryResponse,
  type RequirementsResponse,
  type SetupState,
  type TemplateRow,
} from '@/lib/api';

const key = (...parts: unknown[]) => ['bastion', ...parts];

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['bastion'] });
}

/* ---------------------------------- Reads ---------------------------------- */

export function useSetup() {
  return useQuery({
    queryKey: key('setup'),
    queryFn: () => api.get<{ data: SetupState }>('/setup'),
    // Poll only while an AI-tailored compile is queued or running (spec 6.3).
    refetchInterval: (q) =>
      (q.state.data?.data.frameworks ?? []).some((f) => f.latest_compile_run?.status === 'queued' || f.latest_compile_run?.status === 'running') ? 5000 : false,
  });
}

export function useTemplates() {
  return useQuery({ queryKey: key('templates'), queryFn: () => api.get<{ data: TemplateRow[] }>('/library/templates') });
}

export function useRequirements(frameworkId: string | undefined) {
  return useQuery({
    queryKey: key('requirements', frameworkId),
    queryFn: () => api.get<RequirementsResponse>(`/frameworks/${frameworkId}/requirements`),
    enabled: !!frameworkId,
  });
}

/** The AI compile's "may not apply" suggestions for undecided requirements (#238). */
export function useNotApplicableSuggestions(frameworkId: string | undefined) {
  return useQuery({
    queryKey: key('not-applicable-suggestions', frameworkId),
    queryFn: () => api.get<BastionNotApplicableSuggestions>(`/frameworks/${frameworkId}/not-applicable-suggestions`),
    enabled: !!frameworkId,
  });
}

export function useControls(filters: { framework_id?: string; setup?: string }) {
  return useQuery({
    queryKey: key('controls', filters),
    queryFn: () => api.get<ControlsResponse>('/controls', filters),
  });
}

/* ------------------------------- M5 reads -------------------------------- */

export function useSummary(filters: { framework_id?: string }) {
  return useQuery({ queryKey: key('summary', filters), queryFn: () => api.get<SummaryResponse>('/summary', filters) });
}

export function useCoverage(filters: { framework_id?: string }) {
  return useQuery({ queryKey: key('coverage', filters), queryFn: () => api.get<CoverageResponse>('/coverage', filters) });
}

export function useManualEvidence(filters: { status?: string; stuck?: boolean } = {}) {
  return useQuery({ queryKey: key('manual-evidence', filters), queryFn: () => api.get<EvidenceListResponse>('/manual-evidence', filters) });
}

export function useFeeds(enabled = true) {
  return useQuery({ queryKey: key('feeds'), queryFn: () => api.get<{ data: FeedRow[] }>('/feeds'), enabled, retry: false });
}

export function useFeedKeys(feedId: string | null) {
  return useQuery({
    queryKey: key('feed-keys', feedId),
    queryFn: () => api.get<{ data: FeedKeyRow[] }>(`/feeds/${feedId}/keys`),
    enabled: !!feedId,
  });
}

/* ------------------------------ M5 mutations ------------------------------ */

export function useCreateEvidence() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: BastionManualEvidenceCreate) => api.post<{ data: EvidenceItem }>('/manual-evidence', body),
    onSuccess: invalidate,
  });
}

export function useCheckScanAgain() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: EvidenceItem & { check_result: string } }>(`/manual-evidence/${id}/check-again`, {}),
    onSuccess: invalidate,
  });
}

export function useWithdrawEvidence() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.post(`/manual-evidence/${id}/withdraw`, { confirm: true }),
    onSuccess: invalidate,
  });
}

export function useReviewEvidence() {
  const invalidate = useInvalidate();
  return useMutation({
    // expected_verdict is what the reviewer saw (#216): a stale review gets 409 REVIEW_CHANGED
    // instead of silently replacing someone else's verdict.
    mutationFn: (args: {
      id: string;
      assertion_id: string;
      verdict: 'accepted' | 'shows_exception';
      expected_verdict: 'pending' | 'accepted' | 'shows_exception';
    }) =>
      api.post(`/manual-evidence/${args.id}/links/${args.assertion_id}/review`, { verdict: args.verdict, expected_verdict: args.expected_verdict }),
    onSuccess: invalidate,
  });
}

export function useCreateFeed() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: { feed_key: string; label: string; cadence_days?: number }) => api.post<{ data: FeedRow }>('/feeds', body),
    onSuccess: invalidate,
  });
}

export function useMintFeedKey() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (args: { feedId: string; label?: string }) => api.post<{ data: MintedKey }>(`/feeds/${args.feedId}/keys`, { label: args.label ?? null }),
    onSuccess: invalidate,
  });
}

export function useRevokeFeedKey() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (keyId: string) => api.post(`/feed-keys/${keyId}/revoke`, {}),
    onSuccess: invalidate,
  });
}

export function useBamProjects(enabled: boolean) {
  return useQuery({ queryKey: key('bam-projects'), queryFn: () => bamApi.listProjects(), enabled, retry: false });
}

/* -------------------------------- Mutations -------------------------------- */

export function useAdoptFramework() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (template_key: BastionTemplateKey) => api.post<{ data: { id: string } }>('/frameworks', { template_key }),
    onSuccess: invalidate,
  });
}

/**
 * Start a compile. M7: with an AI provider the run comes back `queued` and the worker drives it;
 * `useAi: false` asks for the library suggestions only (finished at once).
 */
export function useCompileFramework() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (args: string | { frameworkId: string; useAi?: boolean }) => {
      const a = typeof args === 'string' ? { frameworkId: args } : args;
      return api.post(`/frameworks/${a.frameworkId}/compile`, a.useAi === false ? { use_ai: false } : {});
    },
    onSuccess: invalidate,
  });
}

/* ------------------------------ M7: policies ------------------------------ */

export function usePolicies(status: 'active' | 'retired' | 'all' = 'active') {
  return useQuery({ queryKey: key('policies', status), queryFn: () => api.get<{ data: PolicyRow[] }>('/policies', { status }) });
}

export function usePolicyAttestations(id: string | null) {
  return useQuery({
    queryKey: key('policy-attestations', id),
    queryFn: () => api.get<{ data: PolicyAttestations }>(`/policies/${id}/attestations`),
    enabled: !!id,
  });
}

export function usePolicyBody(id: string | null) {
  return useQuery({
    queryKey: key('policy-body', id),
    queryFn: () => api.get<{ data: PolicyBody }>(`/policies/${id}/body`),
    enabled: !!id,
    retry: false,
  });
}

export function useMyAttestations() {
  return useQuery({ queryKey: key('my-attestations'), queryFn: () => api.get<{ data: MyAttestationRow[] }>('/me/attestations') });
}

export function useCreatePolicy() {
  const invalidate = useInvalidate();
  return useMutation({
    // The article by id, or by the slug in the link Beacon shows (#239); the server resolves it.
    mutationFn: (body: ({ beacon_entry_id: string } | { beacon_slug: string }) & { audience?: PolicyAudience; cadence_days?: number; control_id?: string }) =>
      api.post<{ data: PolicyRow }>('/policies', body),
    onSuccess: invalidate,
  });
}

export function useUpdatePolicy() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (args: { id: string; body: { audience?: PolicyAudience; cadence_days?: number; owner_user_id?: string | null; status?: 'active' | 'retired' } }) =>
      api.patch<{ data: PolicyRow }>(`/policies/${args.id}`, args.body),
    onSuccess: invalidate,
  });
}

/** "I have read and understood this": sends back exactly the version and hash that were served. */
export function useAttest() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (args: { id: string; beacon_version: number; body_sha256: string }) =>
      api.post(`/policies/${args.id}/attest`, { beacon_version: args.beacon_version, body_sha256: args.body_sha256 }),
    onSuccess: invalidate,
  });
}

export function useRequestAttestations() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: { due: number; asked: number; nudged: number } }>(`/policies/${id}/request-attestations`, {}),
    onSuccess: invalidate,
  });
}

export function useSaveProfile() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (profile: BastionCompanyProfile) => api.patch('/setup/profile', profile),
    onSuccess: invalidate,
  });
}

export function useSetComplianceProject() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (project_id: string) => api.post('/setup/compliance-project', { project_id }),
    onSuccess: invalidate,
  });
}

/** "Create a Compliance project for me": Bam creates it, then Bastion records it. */
export function useCreateComplianceProject() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: async () => {
      const created = await bamApi.createComplianceProject();
      return api.post('/setup/compliance-project', { project_id: created.data.id });
    },
    onSuccess: invalidate,
  });
}

export function useDecideApplicability(frameworkId: string) {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: BastionBulkApplicability) => api.post(`/frameworks/${frameworkId}/applicability`, body),
    onSuccess: invalidate,
  });
}

export function useConfirmAssertion() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (args: { id: string; population_confirmed?: boolean }) =>
      api.post<{ data: AssertionRow }>(
        `/assertions/${args.id}/confirm`,
        args.population_confirmed === undefined ? {} : { population_confirmed: args.population_confirmed },
      ),
    onSuccess: invalidate,
  });
}

export function useRejectAssertion() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: AssertionRow }>(`/assertions/${id}/reject`, {}),
    onSuccess: invalidate,
  });
}

/* --------------------- M6: gaps, fixes, exceptions, drift --------------------- */

export function useControl(id: string | null) {
  return useQuery({ queryKey: key('control', id), queryFn: () => api.get<{ data: ControlDetail }>(`/controls/${id}`), enabled: !!id });
}

export function useControlEvidence(id: string | null) {
  return useQuery({
    queryKey: key('control-evidence', id),
    queryFn: () => api.get<{ data: EvidenceSnapshotRow[] }>(`/controls/${id}/evidence`, { limit: 20 }),
    enabled: !!id,
  });
}

export function useGaps(filters: { framework_id?: string; control_id?: string; sort?: 'risk' | 'quick_wins'; status?: string }) {
  return useQuery({ queryKey: key('gaps', filters), queryFn: () => api.get<GapsResponse>('/gaps', filters) });
}

export function useFixDrafts(filters: { status?: string; control_id?: string }, enabled = true) {
  return useQuery({
    queryKey: key('fix-drafts', filters),
    queryFn: () => api.get<{ data: FixDraftRow[] }>('/fix-drafts', filters),
    enabled,
    retry: false,
  });
}

export function useExceptions(filters: { status?: string; control_id?: string }) {
  return useQuery({ queryKey: key('exceptions', filters), queryFn: () => api.get<{ data: ExceptionRow[] }>('/exceptions', filters) });
}

export function useDrift(filters: { control_id?: string; unacknowledged?: boolean }) {
  return useQuery({ queryKey: key('drift', filters), queryFn: () => api.get<{ data: DriftRow[] }>('/drift', filters) });
}

/** "Check now": a control-scope evaluation (POST /evaluations, spec 6.1 Control detail). */
export function useCheckControlNow() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (controlId: string) => api.post('/evaluations', { control_id: controlId }),
    onSuccess: invalidate,
  });
}

export function useProposeFix() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (gapId: string) => api.post<{ data: FixDraftRow }>(`/gaps/${gapId}/propose-fix`, {}),
    onSuccess: invalidate,
  });
}

export function useDismissGap() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (args: { id: string; reason: string }) => api.post(`/gaps/${args.id}/dismiss`, { reason: args.reason }),
    onSuccess: invalidate,
  });
}

/** Decide a fix (a vouching route: a signed-in person, never impersonated). Optimistic in the queue. */
export function useDecideFix() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; decision: 'approve' | 'reject'; reason?: string }) =>
      api.post<{ data: FixDraftRow }>(`/fix-drafts/${args.id}/decide`, { decision: args.decision, reason: args.reason ?? null }),
    onMutate: async (args) => {
      await qc.cancelQueries({ queryKey: ['bastion', 'fix-drafts'] });
      const snapshots = qc.getQueriesData<{ data: FixDraftRow[] }>({ queryKey: ['bastion', 'fix-drafts'] });
      for (const [k, v] of snapshots) {
        if (v) qc.setQueryData(k, { ...v, data: v.data.filter((d) => d.id !== args.id) });
      }
      return { snapshots };
    },
    onError: (_err, _args, ctx) => {
      for (const [k, v] of ctx?.snapshots ?? []) qc.setQueryData(k, v);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['bastion'] }),
  });
}

export function useMarkFixApplied() {
  const invalidate = useInvalidate();
  return useMutation({
    // What was made, by id, or (a Beacon article) by the slug in its link (#232).
    mutationFn: (args: { id: string; applied_entity_type?: 'beacon.entry' | 'bolt.rule'; applied_entity_id?: string; applied_entity_slug?: string; note?: string }) =>
      api.post(`/fix-drafts/${args.id}/mark-applied`, {
        applied_entity_type: args.applied_entity_type ?? null,
        applied_entity_id: args.applied_entity_id ?? null,
        ...(args.applied_entity_slug ? { applied_entity_slug: args.applied_entity_slug } : {}),
        note: args.note ?? null,
      }),
    onSuccess: invalidate,
  });
}

export function useProposeException() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: BastionExceptionPropose) => api.post<{ data: ExceptionRow }>('/exceptions', body),
    onSuccess: invalidate,
  });
}

/** Decide an exception (a vouching route). Optimistic in the queue. */
export function useDecideException() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; decision: 'approve' | 'reject'; reason?: string }) =>
      api.post<{ data: ExceptionRow }>(`/exceptions/${args.id}/decide`, { decision: args.decision, confirm: true, reason: args.reason ?? null }),
    onMutate: async (args) => {
      await qc.cancelQueries({ queryKey: ['bastion', 'exceptions'] });
      const snapshots = qc.getQueriesData<{ data: ExceptionRow[] }>({ queryKey: ['bastion', 'exceptions'] });
      for (const [k, v] of snapshots) {
        if (v) qc.setQueryData(k, { ...v, data: v.data.filter((d) => d.id !== args.id || d.status !== 'proposed') });
      }
      return { snapshots };
    },
    onError: (_err, _args, ctx) => {
      for (const [k, v] of ctx?.snapshots ?? []) qc.setQueryData(k, v);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['bastion'] }),
  });
}

export function useAcknowledgeDrift() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.post(`/drift/${id}/acknowledge`, {}),
    onSuccess: invalidate,
  });
}

export function useRevisePopulation() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (args: { id: string; expected_population: string[] }) =>
      api.post<{ data: AssertionRow }>(`/assertions/${args.id}/revise`, { expected_population: args.expected_population }),
    onSuccess: invalidate,
  });
}
