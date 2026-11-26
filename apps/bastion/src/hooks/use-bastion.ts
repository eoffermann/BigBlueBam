import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  BastionBulkApplicability,
  BastionCompanyProfile,
  BastionManualEvidenceCreate,
  BastionTemplateKey,
} from '@bigbluebam/shared';
import {
  api,
  bamApi,
  type AssertionRow,
  type ControlsResponse,
  type CoverageResponse,
  type EvidenceItem,
  type EvidenceListResponse,
  type FeedKeyRow,
  type FeedRow,
  type MintedKey,
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
  return useQuery({ queryKey: key('setup'), queryFn: () => api.get<{ data: SetupState }>('/setup') });
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
    mutationFn: (args: { id: string; assertion_id: string; verdict: 'accepted' | 'shows_exception' }) =>
      api.post(`/manual-evidence/${args.id}/links/${args.assertion_id}/review`, { verdict: args.verdict }),
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

export function useCompileFramework() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (frameworkId: string) => api.post(`/frameworks/${frameworkId}/compile`, {}),
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

export function useRevisePopulation() {
  const invalidate = useInvalidate();
  return useMutation({
    mutationFn: (args: { id: string; expected_population: string[] }) =>
      api.post<{ data: AssertionRow }>(`/assertions/${args.id}/revise`, { expected_population: args.expected_population }),
    onSuccess: invalidate,
  });
}
