/**
 * TanStack Query hooks for the org room list and per-room bookings, plus
 * the book / cancel mutations. Backs the room-booking screen.
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface RoomListItem {
  id: string;
  floor_id: string;
  floor_name: string;
  name: string;
  type: string;
  privacy_default: string;
  capacity: number | null;
  bookable: boolean;
  zone_id: string;
  owner_id: string | null;
}

export interface RoomBooking {
  id: string;
  org_id: string;
  room_id: string;
  book_event_id: string | null;
  organizer_id: string;
  title: string;
  starts_at: string;
  ends_at: string;
  access: string;
  created_at: string;
  cancelled_at: string | null;
}

interface BookingsResponse {
  bookings: RoomBooking[];
  window: { from: string; to: string };
}

export function useRoomsList(opts?: { bookable?: boolean }) {
  const bookable = opts?.bookable ?? false;
  return useQuery({
    queryKey: ['bureau', 'rooms', { bookable }],
    queryFn: async () => {
      const qs = bookable ? '?bookable=1' : '';
      const res = await api<{ data: RoomListItem[] }>(`/rooms${qs}`);
      return res.data;
    },
  });
}

export function useRoomBookings(roomId: string | null | undefined) {
  return useQuery({
    queryKey: ['bureau', 'rooms', roomId, 'bookings'],
    enabled: !!roomId,
    queryFn: async () => {
      const res = await api<{ data: BookingsResponse }>(
        `/rooms/${roomId}/bookings`,
      );
      return res.data;
    },
  });
}

export interface BookRoomInput {
  roomId: string;
  title: string;
  starts_at: string;
  ends_at: string;
  access: 'open' | 'locked';
}

export function useBookRoom() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: BookRoomInput) => {
      const { roomId, ...body } = input;
      const res = await api<{ data: RoomBooking }>(
        `/rooms/${roomId}/bookings`,
        { method: 'POST', body },
      );
      return res.data;
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({
        queryKey: ['bureau', 'rooms', vars.roomId, 'bookings'],
      });
    },
  });
}

export function useCancelBooking() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { bookingId: string; roomId: string }) => {
      const res = await api<{ data: { id: string; cancelled_at: string } }>(
        `/bookings/${input.bookingId}`,
        { method: 'DELETE' },
      );
      return res.data;
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({
        queryKey: ['bureau', 'rooms', vars.roomId, 'bookings'],
      });
    },
  });
}
