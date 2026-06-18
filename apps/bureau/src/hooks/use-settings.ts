/**
 * TanStack Query hooks for the org-wide Bureau settings (GET /v1/settings,
 * PATCH /v1/settings). Backs the org-settings screen.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface BureauSettings {
  org_id: string;
  continuous_audio: boolean;
  allow_auto_follow: boolean;
  free_walk: boolean;
  default_office_privacy: 'open' | 'knock' | 'private';
  members_can_book: boolean;
  members_can_create_rooms: boolean;
  updated_at: string;
}

export type BureauSettingsPatch = Partial<
  Pick<
    BureauSettings,
    | 'continuous_audio'
    | 'allow_auto_follow'
    | 'default_office_privacy'
    | 'members_can_book'
    | 'members_can_create_rooms'
  >
>;

export function useBureauSettings() {
  return useQuery({
    queryKey: ['bureau', 'settings'],
    queryFn: async () => {
      const res = await api<{ data: BureauSettings }>('/settings');
      return res.data;
    },
  });
}

export function useUpdateBureauSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (patch: BureauSettingsPatch) => {
      const res = await api<{ data: BureauSettings }>('/settings', {
        method: 'PATCH',
        body: patch,
      });
      return res.data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['bureau', 'settings'], data);
    },
  });
}
