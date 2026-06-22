import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

// ── Types ────────────────────────────────────────────────────────────

export type DocumentStatus = 'draft' | 'in_review' | 'approved' | 'archived';
export type DocumentVisibility = 'public' | 'organization' | 'project' | 'private';

export interface BriefDocument {
  id: string;
  slug: string;
  title: string;
  icon: string | null;
  plain_text: string | null;
  html_snapshot: string | null;
  cover_image_url: string | null;
  template_id: string | null;
  status: DocumentStatus;
  visibility: DocumentVisibility;
  pinned: boolean;
  word_count: number;
  promoted_to_beacon_id: string | null;
  project_id: string | null;
  project_name: string | null;
  folder_id: string | null;
  created_by: string;
  updated_by: string | null;
  creator_name: string | null;
  creator_avatar_url?: string | null;
  summary?: string | null;
  published_at?: string | null;
  version?: number;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export interface BriefFolder {
  id: string;
  name: string;
  parent_id: string | null;
  project_id: string | null;
  document_count: number;
  created_at: string;
}

export interface BriefVersion {
  id: string;
  document_id: string;
  version_number: number;
  title: string;
  plain_text: string | null;
  change_summary: string | null;
  word_count: number;
  created_by: string;
  changed_by_name: string | null;
  created_at: string;
}

export interface BriefComment {
  id: string;
  document_id: string;
  body: string;
  author_id: string;
  creator_name: string | null;
  creator_avatar_url: string | null;
  is_resolved: boolean;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface BriefTemplate {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  category: string | null;
  html_preview: string | null;
  sort_order: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface BriefEmbed {
  id: string;
  document_id: string;
  embed_type: string;
  embed_url: string;
  label: string | null;
  created_at: string;
}

export interface DocumentStats {
  total: number;
  in_review: number;
  recent: number;
}

// ── Filters ──────────────────────────────────────────────────────────

export interface DocumentListFilters {
  status?: DocumentStatus;
  project_id?: string;
  folder_id?: string;
  search?: string;
}

// ── Response shapes ─────────────────────────────────────────────────

interface PaginatedResponse<T> {
  data: T[];
  meta?: {
    next_cursor?: string | null;
    has_more?: boolean;
  };
}

interface ApiResponse<T> {
  data: T;
}

// ── Query hooks ──────────────────────────────────────────────────────

export function useDocumentList(filters: DocumentListFilters = {}) {
  return useInfiniteQuery({
    queryKey: ['documents', filters],
    queryFn: ({ pageParam }) =>
      api.get<PaginatedResponse<BriefDocument>>('/documents', {
        ...filters,
        cursor: pageParam as string | undefined,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) =>
      lastPage.meta?.has_more ? lastPage.meta.next_cursor : undefined,
  });
}

export function useDocument(idOrSlug: string | undefined) {
  return useQuery({
    queryKey: ['documents', idOrSlug],
    queryFn: () => api.get<ApiResponse<BriefDocument>>(`/documents/${idOrSlug}`),
    enabled: !!idOrSlug,
    select: (res) => res.data,
  });
}

export function useDocumentStats() {
  return useQuery({
    queryKey: ['document-stats'],
    queryFn: () => api.get<ApiResponse<DocumentStats>>('/documents/stats'),
    select: (res) => res.data,
    staleTime: 60_000,
  });
}

export function useStarredDocuments() {
  return useQuery({
    queryKey: ['documents', 'starred'],
    queryFn: () => api.get<PaginatedResponse<BriefDocument>>('/documents/starred'),
    select: (res) => res.data,
  });
}

export function useRecentDocuments() {
  return useQuery({
    queryKey: ['documents', 'recent'],
    queryFn: () => api.get<PaginatedResponse<BriefDocument>>('/documents/recent'),
    select: (res) => res.data,
  });
}

// ── Mutation hooks ───────────────────────────────────────────────────

export function useCreateDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      title: string;
      plain_text: string;
      html_snapshot?: string;
      summary?: string;
      icon?: string;
      project_id?: string;
      folder_id?: string;
      template_id?: string;
      visibility?: DocumentVisibility;
      status?: DocumentStatus;
    }) => api.post<ApiResponse<BriefDocument>>('/documents', data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['document-stats'] });
    },
  });
}

export function useUpdateDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: {
      id: string;
      data: Partial<{
        title: string;
        plain_text: string;
        html_snapshot: string;
        summary: string;
        icon: string;
        visibility: DocumentVisibility;
        status: DocumentStatus;
        folder_id: string | null;
      }>;
    }) => api.patch<ApiResponse<BriefDocument>>(`/documents/${id}`, data),
    onSuccess: (_res, variables) => {
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['documents', variables.id] });
      qc.invalidateQueries({ queryKey: ['document-stats'] });
    },
  });
}

export function useArchiveDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/documents/${id}`),
    onSuccess: (_res, id) => {
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['documents', id] });
      qc.invalidateQueries({ queryKey: ['document-stats'] });
    },
  });
}

export function useRestoreDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<ApiResponse<BriefDocument>>(`/documents/${id}/restore`),
    onSuccess: (_res, id) => {
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['documents', id] });
      qc.invalidateQueries({ queryKey: ['document-stats'] });
    },
  });
}

export function useDuplicateDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<ApiResponse<BriefDocument>>(`/documents/${id}/duplicate`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['document-stats'] });
    },
  });
}

export function useToggleStar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<ApiResponse<{ starred: boolean }>>(`/documents/${id}/star`),
    onSuccess: (_res, id) => {
      qc.invalidateQueries({ queryKey: ['documents'] });
      qc.invalidateQueries({ queryKey: ['documents', id] });
      qc.invalidateQueries({ queryKey: ['documents', 'starred'] });
    },
  });
}

export function usePromoteToBeacon() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<ApiResponse<{ beacon_id: string }>>(`/documents/${id}/promote`),
    onSuccess: (_res, id) => {
      qc.invalidateQueries({ queryKey: ['documents', id] });
    },
  });
}
