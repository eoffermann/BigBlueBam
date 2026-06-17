import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface BlankField {
  id: string;
  form_id: string;
  field_key: string;
  label: string;
  description: string | null;
  placeholder: string | null;
  field_type: string;
  required: boolean;
  min_length: number | null;
  max_length: number | null;
  min_value: string | null;
  max_value: string | null;
  regex_pattern: string | null;
  options: unknown;
  scale_min: number;
  scale_max: number;
  scale_min_label: string | null;
  scale_max_label: string | null;
  sort_order: number;
  page_number: number;
  column_span: number;
  default_value: string | null;
  conditional_logic: unknown;
  created_at: string;
  updated_at: string;
}

export interface BlankForm {
  id: string;
  name: string;
  description: string | null;
  slug: string;
  form_type: string;
  visibility: 'public' | 'org' | 'project';
  expires_at: string | null;
  project_id: string | null;
  status: string;
  accept_responses: boolean;
  show_progress_bar: boolean;
  confirmation_type: string;
  confirmation_message: string | null;
  theme_color: string;
  header_image_url?: string | null;
  one_per_email?: boolean;
  requires_login?: boolean;
  allowed_domains?: string[] | null;
  notify_on_submit?: boolean;
  notify_emails?: string[] | null;
  notify_banter_channel_id?: string | null;
  submission_count?: number;
  field_count?: number;
  fields?: BlankField[];
  published_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export function useForms(params?: { status?: string; project_id?: string }) {
  return useQuery({
    queryKey: ['blank', 'forms', params],
    queryFn: () => api.get<{ data: BlankForm[] }>('/v1/forms', params),
  });
}

export function useForm(id: string | undefined) {
  return useQuery({
    queryKey: ['blank', 'forms', id],
    queryFn: () => api.get<{ data: BlankForm }>(`/v1/forms/${id}`),
    enabled: !!id,
  });
}

export function useCreateForm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<BlankForm> & { slug: string; name: string }) =>
      api.post<{ data: BlankForm }>('/v1/forms', data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blank', 'forms'] }),
  });
}

export function useUpdateForm(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<BlankForm>) =>
      api.patch<{ data: BlankForm }>(`/v1/forms/${id}`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['blank', 'forms'] });
      qc.invalidateQueries({ queryKey: ['blank', 'forms', id] });
    },
  });
}

export function useDeleteForm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/v1/forms/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blank', 'forms'] }),
  });
}

export function usePublishForm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: BlankForm }>(`/v1/forms/${id}/publish`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blank', 'forms'] }),
  });
}

export function useDuplicateForm() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: BlankForm }>(`/v1/forms/${id}/duplicate`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['blank', 'forms'] }),
  });
}

export function useFormSubmissions(formId: string | undefined, params?: { cursor?: string; limit?: number }) {
  return useQuery({
    queryKey: ['blank', 'submissions', formId, params],
    queryFn: () =>
      api.get<{ data: unknown[]; meta: { next_cursor: string | null; has_more: boolean } }>(
        `/v1/forms/${formId}/submissions`,
        params,
      ),
    enabled: !!formId,
  });
}

export function useFormAnalytics(formId: string | undefined) {
  return useQuery({
    queryKey: ['blank', 'analytics', formId],
    queryFn: () => api.get<{ data: unknown }>(`/v1/forms/${formId}/analytics`),
    enabled: !!formId,
  });
}

// Fetch the user's projects directly from the Bam API so the form-builder
// can show a project picker when visibility='project'. Uses the same
// session cookie as the Blank SPA, so no extra auth wiring is required.
interface BamProject {
  id: string;
  name: string;
  slug?: string;
}

export function useBamProjects() {
  return useQuery({
    queryKey: ['blank', 'bam-projects'],
    queryFn: async () => {
      const res = await fetch('/b3/api/v1/projects', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return { data: [] as BamProject[] };
      const json = (await res.json()) as { data?: BamProject[] };
      return { data: json.data ?? [] };
    },
    staleTime: 60_000,
  });
}

// Fetch the org's public Banter channels so the form-builder can offer a
// "post to this channel on submit" picker. Uses the shared session cookie,
// same pattern as useBamProjects.
interface BanterChannelOption {
  id: string;
  name: string;
}

export function useBanterChannels() {
  return useQuery({
    queryKey: ['blank', 'banter-channels'],
    queryFn: async () => {
      const res = await fetch('/banter/api/v1/channels/browse', {
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return { data: [] as BanterChannelOption[] };
      const json = (await res.json()) as { data?: BanterChannelOption[] };
      return { data: json.data ?? [] };
    },
    staleTime: 60_000,
  });
}
