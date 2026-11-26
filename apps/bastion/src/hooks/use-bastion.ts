import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BastionBulkApplicability, BastionCompanyProfile, BastionTemplateKey } from '@bigbluebam/shared';
import {
  api,
  bamApi,
  type AssertionRow,
  type ControlsResponse,
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
