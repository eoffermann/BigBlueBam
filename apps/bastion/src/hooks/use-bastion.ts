import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { z } from 'zod';
import type {
  BastionAdoptFrameworkResponse,
  BastionCheckScanAgainResponse,
  BastionDeliveryRetryResponse,
  BastionQuestionnaireItemReviewResponse,
  BastionQuestionnaireItemsResponse,
  BastionRequestAttestationsResponse,
  BastionAnswerLibraryUpdate,
  BastionBulkApplicability,
  BastionCompanyProfile,
  BastionExceptionPropose,
  BastionManualEvidenceCreate,
  BastionNotApplicableSuggestions,
  BastionQuestionnaireAutofill,
  BastionQuestionnaireItemReview,
  BastionTemplateKey,
  BastionAuditorRequestUpdate,
  BastionAuditorRoomCreate,
  BastionExportCreate,
  BastionRestoreResolution,
  BastionSettingsUpdate,
  bastionQuestionnaireCreateSchema,
  bastionQuestionnaireUpdateSchema,
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
  type AnswerLibraryRow,
  type QuestionnaireRow,
  type SummaryResponse,
  type RequirementsResponse,
  type SetupState,
  type TemplateRow,
  type AccessLogRow,
  type AuditorRequestRow,
  type AuditorRoomRow,
  type CreatedRoom,
  type DeliveryProblemRow,
  type ExportRow,
  type RoomOverview,
  type SettingsView,
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
    mutationFn: (id: string) => api.post<BastionCheckScanAgainResponse>(`/manual-evidence/${id}/check-again`, {}),
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

/** The organization's active members, by name (#268): the one source for every Bastion person picker. */
export function useMembers(enabled = true) {
  return useQuery({
    queryKey: key('org-members'),
    queryFn: async () => (await bamApi.listMembers()).data.filter((m) => m.is_active !== false).sort((a, b) => a.display_name.localeCompare(b.display_name)),
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/* -------------------------------- Mutations -------------------------------- */

export function useAdoptFramework() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (template_key: BastionTemplateKey) => api.post<BastionAdoptFrameworkResponse>('/frameworks', { template_key }),
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

/* ------------------------------ M8: questionnaires ------------------------------ */

export function useQuestionnaires() {
  return useQuery({ queryKey: key('questionnaires'), queryFn: () => api.get<{ data: QuestionnaireRow[] }>('/questionnaires') });
}

/** Polls only while Bastion is drafting (spec 6.3). */
export function useQuestionnaire(id: string) {
  return useQuery({
    queryKey: key('questionnaire', id),
    queryFn: () => api.get<{ data: QuestionnaireRow }>(`/questionnaires/${id}`),
    refetchInterval: (q) => (q.state.data?.data.status === 'answering' ? 5000 : false),
  });
}

export function useQuestionnaireItems(id: string, drafting: boolean) {
  return useQuery({
    queryKey: key('questionnaire-items', id),
    queryFn: () => api.get<BastionQuestionnaireItemsResponse>(`/questionnaires/${id}/items`),
    refetchInterval: drafting ? 5000 : false,
  });
}

export function useCreateQuestionnaire() {
  const invalidate = useInvalidate();
  return useMutation({
    // #272: the shared request body (z.input, so defaults may be left out).
    mutationFn: (body: z.input<typeof bastionQuestionnaireCreateSchema>) => api.post<{ data: QuestionnaireRow }>('/questionnaires', body),
    onSuccess: invalidate,
  });
}

export function useUpdateQuestionnaire() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (args: { id: string; body: z.input<typeof bastionQuestionnaireUpdateSchema> }) => api.patch<{ data: QuestionnaireRow }>(`/questionnaires/${args.id}`, args.body),
    onSuccess: invalidate,
  });
}

export function useAutofill() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (args: { id: string } & Partial<BastionQuestionnaireAutofill>) =>
      api.post<{ data: QuestionnaireRow }>(`/questionnaires/${args.id}/autofill`, { redraft: args.redraft ?? false }),
    onSuccess: invalidate,
  });
}

/** Review one answer; optimistic in the grid, rolled back on failure (spec 6.3). */
export function useReviewItem(questionnaireId: string) {
  const qc = useQueryClient();
  const itemsKey = key('questionnaire-items', questionnaireId);
  return useMutation({
    mutationFn: (args: { id: string } & BastionQuestionnaireItemReview) => {
      const { id, ...body } = args;
      return api.patch<BastionQuestionnaireItemReviewResponse>(`/questionnaire-items/${id}`, body);
    },
    onMutate: async (args) => {
      await qc.cancelQueries({ queryKey: itemsKey });
      const prev = qc.getQueryData<BastionQuestionnaireItemsResponse>(itemsKey);
      if (prev) {
        qc.setQueryData(itemsKey, {
          ...prev,
          data: prev.data.map((i) => (i.id === args.id ? { ...i, review_status: args.review_status, needs_review: false } : i)),
        });
      }
      return { prev };
    },
    onError: (_e, _a, ctx) => {
      if (ctx?.prev) qc.setQueryData(itemsKey, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['bastion'] }),
  });
}

/** Approve: a vouching route (session, not impersonated, a person). */
export function useApproveQuestionnaire() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: QuestionnaireRow }>(`/questionnaires/${id}/approve`, { confirm: true }),
    onSuccess: invalidate,
  });
}

export function useAnswerLibrary(q: string, includeRetired = false) {
  return useQuery({
    queryKey: key('answer-library', q, includeRetired),
    queryFn: () => api.get<{ data: AnswerLibraryRow[] }>('/answer-library', { q: q || undefined, include_retired: includeRetired ? 'true' : undefined }),
  });
}

export function useUpdateAnswerLibrary() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (args: { id: string; body: BastionAnswerLibraryUpdate }) => api.patch(`/answer-library/${args.id}`, args.body),
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
    mutationFn: (id: string) => api.post<BastionRequestAttestationsResponse>(`/policies/${id}/request-attestations`, {}),
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

/* ------------------------------ M9: sharing and settings ------------------------------ */

export function useAuditorRooms(enabled = true) {
  return useQuery({ queryKey: key('auditor-rooms'), queryFn: () => api.get<{ data: AuditorRoomRow[] }>('/auditor-rooms'), enabled, retry: false });
}

export function useRoomAccessLog(id: string | null) {
  return useQuery({
    queryKey: key('auditor-room-access-log', id),
    queryFn: () => api.get<{ data: AccessLogRow[] }>(`/auditor-rooms/${id}/access-log`),
    enabled: !!id,
  });
}

export function useRoomPreview(id: string | null) {
  return useQuery({
    queryKey: key('auditor-room-preview', id),
    queryFn: () => api.get<{ data: RoomOverview }>(`/auditor-rooms/${id}/preview`),
    enabled: !!id,
  });
}

export function useCreateRoom() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: Omit<BastionAuditorRoomCreate, 'confirm'>) => api.post<{ data: CreatedRoom }>('/auditor-rooms', { ...body, confirm: true }),
    onSuccess: invalidate,
  });
}

export function useRevokeRoom() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: AuditorRoomRow }>(`/auditor-rooms/${id}/revoke`, { confirm: true }),
    onSuccess: invalidate,
  });
}

export function useUnlockRoom() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: AuditorRoomRow }>(`/auditor-rooms/${id}/unlock`, {}),
    onSuccess: invalidate,
  });
}

export function useAuditorRequests(enabled = true) {
  return useQuery({ queryKey: key('auditor-requests'), queryFn: () => api.get<{ data: AuditorRequestRow[] }>('/auditor-requests'), enabled, retry: false });
}

export function useUpdateAuditorRequest() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (args: { id: string; body: BastionAuditorRequestUpdate }) => api.patch(`/auditor-requests/${args.id}`, args.body),
    onSuccess: invalidate,
  });
}

export function useExports(enabled = true) {
  return useQuery({
    queryKey: key('exports'),
    queryFn: () => api.get<{ data: ExportRow[] }>('/exports'),
    enabled,
    retry: false,
    // Poll only while a packet is being built (spec 6.3).
    refetchInterval: (q) => ((q.state.data?.data ?? []).some((p) => p.status === 'queued' || p.status === 'running') ? 5000 : false),
  });
}

export function useCreateExport() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: BastionExportCreate) => api.post<{ data: ExportRow }>('/exports', body),
    onSuccess: invalidate,
  });
}

export function useSettings() {
  return useQuery({ queryKey: key('settings'), queryFn: () => api.get<{ data: SettingsView }>('/settings'), retry: false });
}

export function useUpdateSettings() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (body: BastionSettingsUpdate) => api.patch<{ data: SettingsView }>('/settings', body),
    onSuccess: invalidate,
  });
}

export function useDeliveryProblems(enabled = true) {
  return useQuery({ queryKey: key('delivery-problems'), queryFn: () => api.get<{ data: DeliveryProblemRow[] }>('/delivery-problems'), enabled, retry: false });
}

export function useRetryDelivery() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (id: string) => api.post<BastionDeliveryRetryResponse>(`/delivery-problems/${id}/retry`, {}),
    onSuccess: invalidate,
  });
}

export function useAcknowledgeRestore() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (args: { id: string; resolution: BastionRestoreResolution }) =>
      api.post(`/ledger/restores/${args.id}/acknowledge`, { resolution: args.resolution, confirm: true }),
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
