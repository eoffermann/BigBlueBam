/**
 * Room booking screen — /bureau/booking.
 *
 * Left: the org's bookable rooms (grouped by floor). Right: the selected
 * room's upcoming bookings, a "Book this room" form, and a cancel action
 * per booking. Calls the existing booking endpoints:
 *   GET    /v1/rooms?bookable=1
 *   GET    /v1/rooms/:id/bookings
 *   POST   /v1/rooms/:id/bookings
 *   DELETE /v1/bookings/:id
 *
 * Member booking may be disabled per-org (bureau_settings.members_can_book);
 * the POST 403s in that case and we surface the server message inline.
 */

import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  CalendarPlus,
  CalendarRange,
  Clock,
  DoorOpen,
  Loader2,
  Lock,
  Unlock,
  X,
} from 'lucide-react';
import { BureauApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAuthStore } from '@/stores/auth.store';
import {
  useBookRoom,
  useCancelBooking,
  useRoomBookings,
  useRoomsList,
  type RoomBooking,
  type RoomListItem,
} from '@/hooks/use-rooms';

/** Format an ISO timestamp as a friendly local datetime. */
function fmt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Build a `datetime-local` default value rounded to the next hour. */
function defaultStartLocal(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 1);
  return toLocalInput(d);
}
function defaultEndLocal(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() + 2);
  return toLocalInput(d);
}
/** Date -> 'YYYY-MM-DDTHH:mm' in local time for <input type=datetime-local>. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function BookingPage() {
  const user = useAuthStore((s) => s.user);
  const roomsQuery = useRoomsList({ bookable: true });
  const [selectedRoomId, setSelectedRoomId] = useState<string | null>(null);

  const rooms = roomsQuery.data ?? [];
  const selectedRoom = rooms.find((r) => r.id === selectedRoomId) ?? null;

  // Group rooms by floor for the left column.
  const byFloor = useMemo(() => {
    const groups = new Map<string, { floorName: string; rooms: RoomListItem[] }>();
    for (const r of rooms) {
      const g = groups.get(r.floor_id) ?? { floorName: r.floor_name, rooms: [] };
      g.rooms.push(r);
      groups.set(r.floor_id, g);
    }
    return Array.from(groups.values());
  }, [rooms]);

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold text-zinc-900 dark:text-zinc-100">
          Book a room
        </h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          Reserve a bookable Bureau room for a meeting. Booking locks the room
          for the window and adds it to the organizer&apos;s calendar.
        </p>
      </div>

      {roomsQuery.isLoading ? (
        <div className="flex items-center justify-center h-64">
          <Loader2 className="h-6 w-6 animate-spin text-primary-500" />
        </div>
      ) : roomsQuery.error ? (
        <ErrorPanel message={(roomsQuery.error as Error).message} />
      ) : rooms.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center">
          <CalendarRange className="mx-auto h-10 w-10 text-zinc-400" />
          <h3 className="mt-3 text-sm font-medium text-zinc-900 dark:text-zinc-100">
            No bookable rooms
          </h3>
          <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
            An admin can mark a room as bookable in the floor editor, and it
            will appear here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-6">
          {/* Room picker */}
          <div className="space-y-4">
            {byFloor.map((group) => (
              <div key={group.floorName}>
                <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  {group.floorName}
                </div>
                <div className="space-y-1">
                  {group.rooms.map((room) => (
                    <button
                      key={room.id}
                      type="button"
                      onClick={() => setSelectedRoomId(room.id)}
                      className={cn(
                        'w-full text-left rounded-lg border px-3 py-2 transition-colors',
                        selectedRoomId === room.id
                          ? 'border-primary-500 bg-primary-50 dark:bg-primary-950/30'
                          : 'border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900/40',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <DoorOpen className="h-4 w-4 text-zinc-400 shrink-0" />
                        <span className="font-medium text-sm text-zinc-900 dark:text-zinc-100 truncate flex-1">
                          {room.name}
                        </span>
                      </div>
                      <div className="mt-0.5 ml-6 text-xs text-zinc-500 capitalize">
                        {room.type}
                        {room.capacity ? ` · up to ${room.capacity}` : ''}
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>

          {/* Detail / booking form */}
          <div>
            {selectedRoom ? (
              <RoomBookingPanel
                room={selectedRoom}
                currentUserId={user?.id ?? null}
              />
            ) : (
              <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-12 text-center text-sm text-zinc-500">
                Select a room to view its schedule and book a slot.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface RoomBookingPanelProps {
  room: RoomListItem;
  currentUserId: string | null;
}

function RoomBookingPanel({ room, currentUserId }: RoomBookingPanelProps) {
  const role = useAuthStore((s) => s.user?.role);
  const isSuperuser = useAuthStore((s) => s.user?.is_superuser);
  const isOrgAdmin = isSuperuser === true || role === 'admin' || role === 'owner';
  const bookingsQuery = useRoomBookings(room.id);
  const bookMutation = useBookRoom();
  const cancelMutation = useCancelBooking();

  const [title, setTitle] = useState('');
  const [startsAt, setStartsAt] = useState(defaultStartLocal());
  const [endsAt, setEndsAt] = useState(defaultEndLocal());
  const [access, setAccess] = useState<'open' | 'locked'>('locked');
  const [formError, setFormError] = useState<string | null>(null);

  const bookings = bookingsQuery.data?.bookings ?? [];

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!title.trim()) {
      setFormError('A title is required.');
      return;
    }
    const startIso = new Date(startsAt).toISOString();
    const endIso = new Date(endsAt).toISOString();
    if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
      setFormError('End time must be after start time.');
      return;
    }
    bookMutation.mutate(
      {
        roomId: room.id,
        title: title.trim(),
        starts_at: startIso,
        ends_at: endIso,
        access,
      },
      {
        onSuccess: () => {
          setTitle('');
        },
        onError: (err) => {
          setFormError(
            err instanceof BureauApiError ? err.message : String(err),
          );
        },
      },
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          {room.name}
        </h2>
        <p className="text-xs text-zinc-500 mt-0.5">
          {room.floor_name} · <span className="capitalize">{room.type}</span>
          {room.capacity ? ` · capacity ${room.capacity}` : ''}
        </p>
      </div>

      {/* Book form */}
      <form
        onSubmit={submit}
        className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-3"
      >
        <div className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
          <CalendarPlus className="h-4 w-4 text-primary-500" />
          Book this room
        </div>

        <div>
          <label
            htmlFor="booking-title"
            className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1"
          >
            Title
          </label>
          <input
            id="booking-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Sprint planning"
            maxLength={200}
            className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label
              htmlFor="booking-starts"
              className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1"
            >
              Starts
            </label>
            <input
              id="booking-starts"
              type="datetime-local"
              value={startsAt}
              onChange={(e) => setStartsAt(e.target.value)}
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
          <div>
            <label
              htmlFor="booking-ends"
              className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1"
            >
              Ends
            </label>
            <input
              id="booking-ends"
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              className="w-full rounded-md border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary-500"
            />
          </div>
        </div>

        <div>
          <span className="block text-xs font-medium text-zinc-600 dark:text-zinc-400 mb-1">
            Access
          </span>
          <div className="flex gap-2">
            <AccessToggle
              active={access === 'locked'}
              onClick={() => setAccess('locked')}
              icon={Lock}
              label="Locked"
              hint="Holds the room private for the meeting"
            />
            <AccessToggle
              active={access === 'open'}
              onClick={() => setAccess('open')}
              icon={Unlock}
              label="Open"
              hint="Anyone can wander in"
            />
          </div>
        </div>

        {formError && (
          <div className="text-sm text-red-600 dark:text-red-400 flex items-start gap-1.5">
            <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
            <span>{formError}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={bookMutation.isPending}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-primary-700 disabled:opacity-50"
        >
          {bookMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <CalendarPlus className="h-4 w-4" />
          )}
          Book room
        </button>
      </form>

      {/* Upcoming bookings */}
      <div>
        <div className="px-1 pb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
          Upcoming bookings (next 7 days)
        </div>
        {bookingsQuery.isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
          </div>
        ) : bookingsQuery.error ? (
          <ErrorPanel message={(bookingsQuery.error as Error).message} />
        ) : bookings.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-6 text-center text-sm text-zinc-500">
            No bookings in the next 7 days. This room is wide open.
          </div>
        ) : (
          <ul className="space-y-2">
            {bookings.map((b) => (
              <BookingRow
                key={b.id}
                booking={b}
                canCancel={currentUserId === b.organizer_id || isOrgAdmin}
                busy={
                  cancelMutation.isPending &&
                  cancelMutation.variables?.bookingId === b.id
                }
                onCancel={() =>
                  cancelMutation.mutate({ bookingId: b.id, roomId: room.id })
                }
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function AccessToggle({
  active,
  onClick,
  icon: Icon,
  label,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Lock;
  label: string;
  hint: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      className={cn(
        'flex-1 rounded-md border px-3 py-2 text-left transition-colors',
        active
          ? 'border-primary-500 bg-primary-50 dark:bg-primary-950/30'
          : 'border-zinc-200 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-900/40',
      )}
    >
      <div className="flex items-center gap-1.5 text-sm font-medium text-zinc-900 dark:text-zinc-100">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className="text-[11px] text-zinc-500 mt-0.5">{hint}</div>
    </button>
  );
}

function BookingRow({
  booking,
  canCancel,
  busy,
  onCancel,
}: {
  booking: RoomBooking;
  canCancel: boolean;
  busy: boolean;
  onCancel: () => void;
}) {
  return (
    <li className="rounded-lg border border-zinc-200 dark:border-zinc-800 px-4 py-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="font-medium text-sm text-zinc-900 dark:text-zinc-100 truncate">
          {booking.title}
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-zinc-500">
          <Clock className="h-3 w-3" />
          {fmt(booking.starts_at)} – {fmt(booking.ends_at)}
          <span className="ml-1 inline-flex items-center gap-1 capitalize">
            {booking.access === 'locked' ? (
              <Lock className="h-3 w-3" />
            ) : (
              <Unlock className="h-3 w-3" />
            )}
            {booking.access}
          </span>
        </div>
      </div>
      {canCancel && (
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="inline-flex items-center gap-1 rounded-md border border-zinc-300 dark:border-zinc-700 px-2 py-1 text-xs font-medium text-zinc-700 dark:text-zinc-300 hover:bg-red-50 hover:border-red-300 hover:text-red-700 dark:hover:bg-red-950/30 transition-colors disabled:opacity-50"
        >
          {busy ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <X className="h-3 w-3" />
          )}
          Cancel
        </button>
      )}
    </li>
  );
}

function ErrorPanel({ message }: { message: string }) {
  return (
    <div className="rounded-lg border border-red-300 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-4 flex items-start gap-2">
      <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 mt-0.5 shrink-0" />
      <div className="text-sm text-red-700 dark:text-red-300">{message}</div>
    </div>
  );
}
