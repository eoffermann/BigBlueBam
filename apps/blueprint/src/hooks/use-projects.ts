import { useQuery } from '@tanstack/react-query';
import { bbbGet } from '@/lib/bbb-api';

export interface BamProject {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  archived_at: string | null;
}

/**
 * Pulls the org's project list off the shared Bam API. Blueprint scopes
 * diagrams to projects so the picker in the New Diagram dialog uses
 * this. Projects with `archived_at` are filtered out client-side so the
 * picker doesn't show retired projects.
 */
export function useProjects() {
  return useQuery({
    queryKey: ['blueprint', 'bam', 'projects'],
    queryFn: async () => {
      const json = await bbbGet<{ data: BamProject[] }>('/projects');
      const projects = (json.data ?? []).filter((p) => !p.archived_at);
      return { projects };
    },
    staleTime: 1000 * 60 * 5,
  });
}
