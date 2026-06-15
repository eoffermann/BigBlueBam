import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';

export interface BondUserSettings {
  user_id: string;
  reply_to_email: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** The current user's Bond settings (reply-to address, etc.). */
export function useUserSettings() {
  return useQuery({
    queryKey: ['bond', 'user-settings'],
    queryFn: () => api.get<{ data: BondUserSettings }>('/user-settings'),
    staleTime: 60_000,
  });
}

/** Set or clear the reply-to address. Pass null/'' to clear. */
export function useUpdateUserSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { reply_to_email: string | null }) =>
      api.patch<{ data: BondUserSettings }>('/user-settings', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['bond', 'user-settings'] });
    },
  });
}
