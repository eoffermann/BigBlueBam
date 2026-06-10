/**
 * TanStack Query hooks for the floor list and floor detail endpoints.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { Floor, FloorRoomSummary } from '@/stores/bureau-store';

export interface FloorListItem {
  id: string;
  name: string;
  slug: string;
  background_url: string | null;
  position: number;
  is_default: boolean;
  occupancy: number;
}

export function useFloorsList() {
  return useQuery({
    queryKey: ['bureau', 'floors'],
    queryFn: async () => {
      const res = await api<{ data: FloorListItem[] }>('/floors');
      return res.data;
    },
  });
}

export function useFloor(floorId: string | null | undefined) {
  return useQuery({
    queryKey: ['bureau', 'floors', floorId],
    enabled: !!floorId,
    queryFn: async () => {
      const res = await api<{ data: Floor & { rooms: FloorRoomSummary[] } }>(
        `/floors/${floorId}`,
      );
      return res.data;
    },
  });
}
