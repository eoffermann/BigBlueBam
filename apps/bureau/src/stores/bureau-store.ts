/**
 * Zustand store for the active floor view.
 *
 * The bureau-client SDK is the source of truth for "what room am I in".
 * This store mirrors enough of that into the floor SPA to drive the canvas
 * renderer, plus our own per-room occupancy map (Set of userIds) that we
 * derive from server snapshots and incremental WS deltas.
 */

import { create } from 'zustand';
import type { PresenceStatus } from '@bigbluebam/bureau-client';

export interface FloorRoomSummary {
  id: string;
  name: string;
  zone_id: string;
  occupancy: number;
}

export interface FloorLayoutRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FloorLayoutZone extends FloorLayoutRect {
  /** Stable id that bureau_rooms.zone_id references. */
  id: string;
  /** v1 always 'rect'; future shapes (polygon) reserved. */
  shape?: 'rect';
  /** Editor-only label echo; the room name is authoritative on the row. */
  label?: string;
}

export interface FloorLayout {
  /**
   * Canonical layout shape, matching the seed migration (0177) and the
   * floor editor's serializer (apps/bureau/src/components/floor-editor/
   * zone-types.ts::serializeLayout). Each zone carries the geometry; a
   * room joins to its zone via bureau_rooms.zone_id.
   */
  zones?: FloorLayoutZone[];
  walls?: unknown[];
  width?: number;
  height?: number;
  [k: string]: unknown;
}

export interface Floor {
  id: string;
  org_id: string;
  building_id: string | null;
  name: string;
  slug: string;
  layout: FloorLayout;
  background_url: string | null;
  position: number;
  is_default: boolean;
  occupancy: number;
  rooms: FloorRoomSummary[];
}

interface BureauState {
  /** The full GET /floors/:id payload (or null while loading / between floors). */
  activeFloor: Floor | null;
  /** Per-room occupant id sets, keyed by roomId. */
  occupants: Record<string, Set<string>>;
  /** Per-user current-room mapping for the active floor. */
  userToRoom: Record<string, string | null>;
  /** Self-reported presence statuses keyed by userId. */
  status: Record<string, PresenceStatus | undefined>;

  setActiveFloor: (floor: Floor | null) => void;
  /** Replace the entire occupancy map (used on presence_snapshot). */
  hydrateFromSnapshot: (occupancy: Record<string, string>) => void;
  /** Apply an enter_room delta. */
  applyEnter: (roomId: string, userId: string) => void;
  /** Apply a leave_room delta. */
  applyLeave: (roomId: string, userId: string) => void;
  /** Apply a status change. */
  applyStatus: (userId: string, status: PresenceStatus) => void;
  /** Clear the entire store (e.g. on floor change). */
  reset: () => void;
}

export const useBureauStore = create<BureauState>((set) => ({
  activeFloor: null,
  occupants: {},
  userToRoom: {},
  status: {},

  setActiveFloor: (floor) =>
    set(() => ({
      activeFloor: floor,
    })),

  hydrateFromSnapshot: (occupancy) =>
    set(() => {
      const occupants: Record<string, Set<string>> = {};
      const userToRoom: Record<string, string | null> = {};
      for (const [userId, roomId] of Object.entries(occupancy)) {
        userToRoom[userId] = roomId;
        if (!occupants[roomId]) occupants[roomId] = new Set();
        occupants[roomId].add(userId);
      }
      return { occupants, userToRoom };
    }),

  applyEnter: (roomId, userId) =>
    set((s) => {
      const nextOccupants: Record<string, Set<string>> = { ...s.occupants };
      // Remove from any prior room first.
      const prior = s.userToRoom[userId];
      if (prior && nextOccupants[prior]) {
        const set = new Set(nextOccupants[prior]);
        set.delete(userId);
        nextOccupants[prior] = set;
      }
      const target = new Set(nextOccupants[roomId] ?? []);
      target.add(userId);
      nextOccupants[roomId] = target;
      return {
        occupants: nextOccupants,
        userToRoom: { ...s.userToRoom, [userId]: roomId },
      };
    }),

  applyLeave: (roomId, userId) =>
    set((s) => {
      const nextOccupants: Record<string, Set<string>> = { ...s.occupants };
      if (nextOccupants[roomId]) {
        const next = new Set(nextOccupants[roomId]);
        next.delete(userId);
        nextOccupants[roomId] = next;
      }
      const nextUserToRoom = { ...s.userToRoom };
      if (nextUserToRoom[userId] === roomId) {
        nextUserToRoom[userId] = null;
      }
      return { occupants: nextOccupants, userToRoom: nextUserToRoom };
    }),

  applyStatus: (userId, status) =>
    set((s) => ({ status: { ...s.status, [userId]: status } })),

  reset: () =>
    set(() => ({
      activeFloor: null,
      occupants: {},
      userToRoom: {},
      status: {},
    })),
}));
