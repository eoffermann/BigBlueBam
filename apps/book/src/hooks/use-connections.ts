import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface Connection {
  id: string;
  user_id: string;
  provider: string;
  name: string | null;
  calendar_id: string | null;
  external_calendar_id: string;
  sync_direction: string;
  sync_status: string;
  sync_error: string | null;
  last_sync_at: string | null;
  last_sync_event_count: number;
  has_feed_url: boolean;
  created_at: string;
  updated_at: string;
}

interface ConnectionListResponse {
  data: Connection[];
}

interface ConnectionResponse {
  data: Connection;
}

export interface SyncResult {
  connection_id: string;
  status: string;
  imported: number;
  created: number;
  updated: number;
  removed: number;
  error: string | null;
}

export function useConnections() {
  return useQuery({
    queryKey: ['book', 'connections'],
    queryFn: () => api.get<ConnectionListResponse>('/v1/connections'),
    staleTime: 15_000,
  });
}

export function useCreateIcsConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { feed_url: string; name?: string; calendar_id?: string }) =>
      api.post<ConnectionResponse>('/v1/connections/ics', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['book', 'connections'] });
    },
  });
}

export function useSyncConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.post<{ data: SyncResult }>(`/v1/connections/${id}/sync`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['book', 'connections'] });
      queryClient.invalidateQueries({ queryKey: ['book', 'events'] });
    },
  });
}

export function useDeleteConnection() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/v1/connections/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['book', 'connections'] });
      queryClient.invalidateQueries({ queryKey: ['book', 'events'] });
    },
  });
}
