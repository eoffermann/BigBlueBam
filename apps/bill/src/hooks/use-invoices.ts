import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export function useInvoices(filters?: Record<string, string | undefined>) {
  return useQuery({
    queryKey: ['invoices', filters],
    queryFn: () => api.get<{ data: any[] }>('/v1/invoices', filters),
    select: (res) => res.data,
  });
}

export function useInvoice(id: string | undefined) {
  return useQuery({
    queryKey: ['invoice', id],
    queryFn: () => api.get<{ data: any }>(`/v1/invoices/${id}`),
    select: (res) => res.data,
    enabled: !!id,
  });
}

export function useCreateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: any) => api.post<{ data: any }>('/v1/invoices', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoices'] }),
  });
}

export function useUpdateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: any) => api.patch<{ data: any }>(`/v1/invoices/${id}`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['invoice', vars.id] });
    },
  });
}

export function useDeleteInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/v1/invoices/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoices'] }),
  });
}

export function useFinalizeInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: any }>(`/v1/invoices/${id}/finalize`),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['invoice', id] });
    },
  });
}

export function useSendInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: any }>(`/v1/invoices/${id}/send`),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['invoice', id] });
    },
  });
}

export function useVoidInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: any }>(`/v1/invoices/${id}/void`),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['invoice', id] });
    },
  });
}

export function useDuplicateInvoice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: any }>(`/v1/invoices/${id}/duplicate`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoices'] }),
  });
}

export function useCreateInvoiceFromTime() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      project_id: string;
      client_id: string;
      date_from: string;
      date_to: string;
    }) => api.post<{ data: any }>('/v1/invoices/from-time-entries', body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['invoices'] }),
  });
}

export function useAddLineItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ invoiceId, ...body }: any) =>
      api.post<{ data: any }>(`/v1/invoices/${invoiceId}/line-items`, body),
    onSuccess: (_, vars) => qc.invalidateQueries({ queryKey: ['invoice', vars.invoiceId] }),
  });
}

export function useRecordPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ invoiceId, ...body }: any) =>
      api.post<{ data: any }>(`/v1/invoices/${invoiceId}/payments`, body),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['invoice', vars.invoiceId] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
    },
  });
}
