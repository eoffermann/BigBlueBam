import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface RecurringLineItem {
  description: string;
  quantity?: number;
  unit?: string;
  unit_price: number;
}

export interface CreateRecurringBody {
  client_id: string;
  name: string;
  cadence: 'weekly' | 'monthly' | 'quarterly' | 'annually';
  auto_finalize?: boolean;
  currency?: string;
  tax_rate?: number;
  payment_terms_days?: number;
  start_date?: string;
  end_date?: string;
  notes?: string;
  line_items?: RecurringLineItem[];
}

export function useRecurringList(filters?: Record<string, string | undefined>) {
  return useQuery({
    queryKey: ['recurring', filters],
    queryFn: () => api.get<{ data: any[] }>('/v1/recurring-invoices', filters),
    select: (res) => res.data,
  });
}

export function useRecurring(id: string | undefined) {
  return useQuery({
    queryKey: ['recurring-detail', id],
    queryFn: () => api.get<{ data: any }>(`/v1/recurring-invoices/${id}`),
    select: (res) => res.data,
    enabled: !!id,
  });
}

export function useCreateRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateRecurringBody) =>
      api.post<{ data: any }>('/v1/recurring-invoices', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring'] }),
  });
}

export function useUpdateRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: any) =>
      api.patch<{ data: any }>(`/v1/recurring-invoices/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring'] }),
  });
}

export function usePauseRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: any }>(`/v1/recurring-invoices/${id}/pause`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring'] }),
  });
}

export function useResumeRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: any }>(`/v1/recurring-invoices/${id}/resume`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring'] }),
  });
}

export function useCancelRecurring() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: any }>(`/v1/recurring-invoices/${id}/cancel`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['recurring'] }),
  });
}

export function useGenerateRecurringNow() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<{ data: any }>(`/v1/recurring-invoices/${id}/generate-now`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['recurring'] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
    },
  });
}
