import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useExpenses(filters?: Record<string, string | undefined>) {
  return useQuery({
    queryKey: ['expenses', filters],
    queryFn: () => api.get<{ data: any[] }>('/v1/expenses', filters),
    select: (res) => res.data,
  });
}

export function useCreateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: any) => api.post<{ data: any }>('/v1/expenses', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  });
}

export function useUpdateExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: any) => api.patch<{ data: any }>(`/v1/expenses/${id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  });
}

export function useDeleteExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/v1/expenses/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  });
}

export function useApproveExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/v1/expenses/${id}/approve`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  });
}

export function useRejectExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/v1/expenses/${id}/reject`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  });
}

export function useReimburseExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post(`/v1/expenses/${id}/reimburse`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expenses'] }),
  });
}
