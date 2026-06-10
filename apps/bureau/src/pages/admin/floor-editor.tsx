/**
 * Admin floor editor — workstream 9.
 *
 * Renders the canvas + inspector pair for editing a single floor's
 * layout JSONB and the matching room rows. The high-level flow is:
 *
 *   1. GET  /v1/floors/:id              → floor with layout + room list
 *   2. GET  /v1/rooms/:id (×N on demand)→ per-room properties for the
 *                                          inspector (cached by zone id)
 *   3. local edit (drag/draw/inspector) → updates client-side `layout`
 *                                          and pending room patches
 *   4. Save:
 *        a. PATCH /v1/floors/:id        → layout, background_url, name
 *        b. POST  /v1/rooms             → for each newly-drawn zone
 *        c. PATCH /v1/rooms/:id         → for each changed room
 *        d. DELETE /v1/rooms/:id        → for each removed zone
 *
 * We intentionally do NOT use TanStack Query mutations one-by-one on
 * every drag tick: the canvas is real-time at the client level and we
 * commit on the Save button. This matches the spec ("Save calls PATCH
 * /bureau/api/v1/floors/:id with the updated layout").
 *
 * Permission gating: the page checks `canEditFloors(user)` and renders a
 * 403 surface for non-admins. The bureau-api also enforces this, so an
 * admin who lost privilege mid-session will hit a clean error envelope.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Loader2,
  MousePointer2,
  Save,
  Shield,
  Square,
  UserSquare2,
} from 'lucide-react';
import { api, BureauApiError } from '@/lib/api';
import { useAuthStore, type BureauUser } from '@/stores/auth.store';
import { CanvasEditor, type EditorTool } from '@/components/floor-editor/canvas-editor';
import {
  RoomInspector,
  type RoomProperties,
} from '@/components/floor-editor/room-inspector';
import { ImageUnderlayUpload } from '@/components/floor-editor/image-underlay-upload';
import {
  normalizeLayout,
  newZoneId,
  serializeLayout,
  type Zone,
} from '@/components/floor-editor/zone-types';

const ROLE_HIERARCHY = ['viewer', 'member', 'admin', 'owner'] as const;
function roleLevel(role: string): number {
  const idx = ROLE_HIERARCHY.indexOf(role as (typeof ROLE_HIERARCHY)[number]);
  return idx >= 0 ? idx : -1;
}
function canEditFloors(user: BureauUser | null): boolean {
  if (!user) return false;
  if (user.is_superuser) return true;
  return roleLevel(user.role) >= roleLevel('admin');
}

interface FloorResponse {
  data: {
    id: string;
    name: string;
    slug: string;
    layout: unknown;
    background_url: string | null;
    rooms: Array<{ id: string; name: string; zone_id: string; occupancy: number }>;
  };
}

interface RoomResponse {
  data: {
    id: string;
    name: string;
    type: RoomProperties['type'];
    capacity: number | null;
    privacy_default: RoomProperties['privacy_default'];
    bookable: boolean;
    owner_id: string | null;
    zone_id: string;
  };
}

export interface FloorEditorPageProps {
  floorId: string;
  onNavigate: (path: string) => void;
}

/**
 * Per-zone editor state. Each entry is "the eventual server state" — we
 * apply diffs to the canvas + room layer here, then flush on Save. The
 * room_id is null until the row exists (newly-drawn zones).
 */
interface ZoneEditState {
  zone: Zone;
  room: RoomProperties | null;
  /** Original (last-server) room id, when known. */
  roomId: string | null;
  /** Set after a draw/zone-add that has no server row yet. */
  isNew: boolean;
  /** Set when the user removed it locally; flushed as DELETE on save. */
  isDeleted: boolean;
}

export function FloorEditorPage({ floorId, onNavigate }: FloorEditorPageProps) {
  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();

  // ─── Server queries ─────────────────────────────────────────────────
  const floorQuery = useQuery<FloorResponse>({
    queryKey: ['bureau', 'floor', floorId],
    queryFn: () => api<FloorResponse>(`/floors/${floorId}`),
    enabled: !!user,
  });
  const floor = floorQuery.data?.data;

  // We fetch each referenced room individually (it's how /v1/rooms/:id is
  // shaped today). The bureau-api floor-detail endpoint gives us only
  // {id, name, zone_id, occupancy}, so the inspector still needs a per-
  // room round-trip for type/capacity/privacy_default/bookable/owner_id.
  // This pulls in parallel, all cached by react-query.
  const roomIds = useMemo(() => (floor?.rooms ?? []).map((r) => r.id), [floor?.rooms]);
  const roomsQuery = useQuery<Record<string, RoomResponse['data']>>({
    queryKey: ['bureau', 'rooms', roomIds.join(',')],
    queryFn: async () => {
      const entries = await Promise.all(
        roomIds.map(async (rid) => {
          try {
            const res = await api<RoomResponse>(`/rooms/${rid}`);
            return [rid, res.data] as const;
          } catch {
            return null;
          }
        }),
      );
      const out: Record<string, RoomResponse['data']> = {};
      for (const e of entries) {
        if (e) out[e[0]] = e[1];
      }
      return out;
    },
    enabled: roomIds.length > 0,
  });

  // ─── Local edit state ───────────────────────────────────────────────
  const [floorName, setFloorName] = useState('');
  const [backgroundUrl, setBackgroundUrl] = useState<string | null>(null);
  const [width, setWidth] = useState(1200);
  const [height, setHeight] = useState(800);
  const [zoneStates, setZoneStates] = useState<ZoneEditState[]>([]);
  const [selectedZoneId, setSelectedZoneId] = useState<string | null>(null);
  const [tool, setTool] = useState<EditorTool>('select');
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Seed/refresh local state when the floor query lands.
  useEffect(() => {
    if (!floor) return;
    const layout = normalizeLayout(floor.layout);
    setFloorName(floor.name);
    setBackgroundUrl(floor.background_url ?? null);
    setWidth(layout.width);
    setHeight(layout.height);
    const roomsByZone = new Map<string, { id: string; name: string }>();
    for (const r of floor.rooms) roomsByZone.set(r.zone_id, { id: r.id, name: r.name });
    setZoneStates(
      layout.zones.map((z) => ({
        zone: { ...z, label: roomsByZone.get(z.id)?.name ?? z.label },
        room: null,
        roomId: roomsByZone.get(z.id)?.id ?? null,
        isNew: false,
        isDeleted: false,
      })),
    );
    setDirty(false);
  }, [floor]);

  // Hydrate room properties once the per-room query lands.
  useEffect(() => {
    const map = roomsQuery.data;
    if (!map) return;
    setZoneStates((prev) =>
      prev.map((s) => {
        if (s.isNew || !s.roomId) return s;
        const r = map[s.roomId];
        if (!r) return s;
        return {
          ...s,
          room: {
            name: r.name,
            type: r.type,
            capacity: r.capacity,
            privacy_default: r.privacy_default,
            bookable: r.bookable,
            owner_id: r.owner_id,
          },
        };
      }),
    );
  }, [roomsQuery.data]);

  // ─── Canvas / inspector wiring ──────────────────────────────────────

  // The canvas works in raw Zone[] — we project our editing state down.
  const visibleZones = useMemo(
    () => zoneStates.filter((s) => !s.isDeleted).map((s) => s.zone),
    [zoneStates],
  );

  const onZonesChange = useCallback((nextZones: Zone[]) => {
    setZoneStates((prev) => {
      const byId = new Map(nextZones.map((z) => [z.id, z]));
      let changed = false;
      const next = prev.map((s) => {
        const updated = byId.get(s.zone.id);
        if (!updated) return s;
        if (
          updated.x === s.zone.x &&
          updated.y === s.zone.y &&
          updated.w === s.zone.w &&
          updated.h === s.zone.h
        ) {
          return s;
        }
        changed = true;
        return { ...s, zone: { ...s.zone, x: updated.x, y: updated.y, w: updated.w, h: updated.h } };
      });
      if (changed) setDirty(true);
      return next;
    });
  }, []);

  const onDrawComplete = useCallback<
    React.ComponentProps<typeof CanvasEditor>['onDrawComplete']
  >(
    (draft) => {
      const id = newZoneId();
      const label = draft.kind === 'office' ? 'New office' : 'New room';
      const initialRoom: RoomProperties = {
        name: label,
        type: draft.kind === 'office' ? 'office' : 'open',
        capacity: null,
        privacy_default: draft.kind === 'office' ? 'knock' : 'open',
        bookable: false,
        owner_id: null,
      };
      setZoneStates((prev) => [
        ...prev,
        {
          zone: {
            id,
            label,
            kind: draft.kind,
            shape: 'rect',
            x: draft.x,
            y: draft.y,
            w: draft.w,
            h: draft.h,
          },
          room: initialRoom,
          roomId: null,
          isNew: true,
          isDeleted: false,
        },
      ]);
      setSelectedZoneId(id);
      setTool('select');
      setDirty(true);
    },
    [],
  );

  const selected = useMemo(
    () => zoneStates.find((s) => s.zone.id === selectedZoneId && !s.isDeleted) ?? null,
    [zoneStates, selectedZoneId],
  );

  const onZonePatch = useCallback(
    (zoneId: string, patch: Partial<Pick<Zone, 'label' | 'x' | 'y' | 'w' | 'h' | 'kind'>>) => {
      setZoneStates((prev) =>
        prev.map((s) => (s.zone.id === zoneId ? { ...s, zone: { ...s.zone, ...patch } } : s)),
      );
      setDirty(true);
    },
    [],
  );

  const onRoomPatch = useCallback((zoneId: string, patch: Partial<RoomProperties>) => {
    setZoneStates((prev) =>
      prev.map((s) =>
        s.zone.id === zoneId
          ? {
              ...s,
              room: {
                ...(s.room ?? {
                  name: s.zone.label,
                  type: s.zone.kind === 'office' ? 'office' : 'open',
                  capacity: null,
                  privacy_default: 'open',
                  bookable: false,
                  owner_id: null,
                }),
                ...patch,
              },
            }
          : s,
      ),
    );
    setDirty(true);
  }, []);

  const onDeleteZone = useCallback((zoneId: string) => {
    setZoneStates((prev) =>
      prev
        .map((s) => {
          if (s.zone.id !== zoneId) return s;
          if (s.isNew) return null; // drop new zones outright
          return { ...s, isDeleted: true };
        })
        .filter((s): s is ZoneEditState => s !== null),
    );
    setSelectedZoneId((cur) => (cur === zoneId ? null : cur));
    setDirty(true);
  }, []);

  // ─── Save ───────────────────────────────────────────────────────────

  const onSave = useCallback(async () => {
    if (!floor) return;
    setSaveError(null);
    setSaving(true);
    try {
      // 1. Floor PATCH: layout JSONB, name, background_url, size.
      const liveZones = zoneStates.filter((s) => !s.isDeleted).map((s) => s.zone);
      const layoutJson = serializeLayout({ width, height, zones: liveZones, walls: [] });
      await api(`/floors/${floor.id}`, {
        method: 'PATCH',
        body: {
          name: floorName,
          background_url: backgroundUrl,
          layout: layoutJson,
        },
      });

      // 2. For new zones: POST /rooms.
      for (const s of zoneStates) {
        if (!s.isNew || s.isDeleted) continue;
        const props: RoomProperties = s.room ?? {
          name: s.zone.label,
          type: s.zone.kind === 'office' ? 'office' : 'open',
          capacity: null,
          privacy_default: s.zone.kind === 'office' ? 'knock' : 'open',
          bookable: false,
          owner_id: null,
        };
        await api(`/rooms`, {
          method: 'POST',
          body: {
            floor_id: floor.id,
            zone_id: s.zone.id,
            name: props.name,
            type: props.type,
            capacity: props.capacity,
            privacy_default: props.privacy_default,
            bookable: props.bookable,
            owner_id: props.owner_id,
          },
        });
      }

      // 3. For existing zones with edits: PATCH /rooms/:id.
      for (const s of zoneStates) {
        if (s.isNew || s.isDeleted || !s.roomId || !s.room) continue;
        await api(`/rooms/${s.roomId}`, {
          method: 'PATCH',
          body: {
            name: s.room.name,
            type: s.room.type,
            capacity: s.room.capacity,
            privacy_default: s.room.privacy_default,
            bookable: s.room.bookable,
            owner_id: s.room.owner_id,
            zone_id: s.zone.id,
          },
        });
      }

      // 4. For deleted zones: DELETE /rooms/:id.
      for (const s of zoneStates) {
        if (!s.isDeleted || !s.roomId) continue;
        await api(`/rooms/${s.roomId}`, { method: 'DELETE' });
      }

      // Refetch from server. The local state will reseed via the
      // useEffect above, which also clears `dirty`.
      await queryClient.invalidateQueries({ queryKey: ['bureau', 'floor', floor.id] });
      await queryClient.invalidateQueries({ queryKey: ['bureau', 'rooms'] });
    } catch (err) {
      if (err instanceof BureauApiError) {
        setSaveError(`${err.code}: ${err.message}`);
      } else {
        setSaveError(err instanceof Error ? err.message : 'Save failed');
      }
    } finally {
      setSaving(false);
    }
  }, [floor, zoneStates, width, height, floorName, backgroundUrl, queryClient]);

  // ─── Render gating ──────────────────────────────────────────────────

  if (!canEditFloors(user)) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-50 dark:bg-zinc-950">
        <div className="max-w-md rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 p-6 text-center">
          <Shield className="mx-auto h-8 w-8 text-amber-500" />
          <h1 className="mt-3 text-base font-semibold text-zinc-900 dark:text-zinc-100">
            Admin access required
          </h1>
          <p className="mt-1 text-sm text-zinc-500">
            The floor editor is restricted to org admins, owners, and SuperUsers.
          </p>
          <button
            onClick={() => onNavigate('/')}
            className="mt-4 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-zinc-200 dark:border-zinc-700 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <ArrowLeft className="h-4 w-4" /> Back to Bureau
          </button>
        </div>
      </div>
    );
  }

  if (floorQuery.isLoading) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-50 dark:bg-zinc-950">
        <Loader2 className="h-6 w-6 animate-spin text-blue-500" />
      </div>
    );
  }

  if (floorQuery.isError || !floor) {
    return (
      <div className="flex items-center justify-center h-screen bg-zinc-50 dark:bg-zinc-950 text-zinc-500">
        <div className="text-center">
          <p>Floor not found or could not be loaded.</p>
          <button
            onClick={() => onNavigate('/')}
            className="mt-3 inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-md border border-zinc-200 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-zinc-50 dark:bg-zinc-950">
      {/* Top toolbar */}
      <div className="flex items-center gap-3 px-3 h-12 border-b border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shrink-0">
        <button
          onClick={() => onNavigate('/')}
          className="flex items-center justify-center h-8 w-8 rounded-md text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
          title="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </button>

        <input
          value={floorName}
          onChange={(e) => {
            setFloorName(e.target.value);
            setDirty(true);
          }}
          className="text-sm font-semibold bg-transparent border-0 outline-none focus:ring-1 focus:ring-blue-500 rounded px-1 text-zinc-900 dark:text-zinc-100 min-w-[140px]"
        />

        <div className="text-[11px] text-zinc-500 hidden md:inline">
          {visibleZones.length} zones · {width}×{height}
        </div>

        <div className="flex-1" />

        {/* Tool selector */}
        <div className="inline-flex rounded-md border border-zinc-200 dark:border-zinc-700 overflow-hidden">
          <ToolButton
            active={tool === 'select'}
            onClick={() => setTool('select')}
            icon={<MousePointer2 className="h-3.5 w-3.5" />}
            label="Select"
          />
          <ToolButton
            active={tool === 'draw-room'}
            onClick={() => setTool('draw-room')}
            icon={<Square className="h-3.5 w-3.5" />}
            label="New room"
          />
          <ToolButton
            active={tool === 'draw-office'}
            onClick={() => setTool('draw-office')}
            icon={<UserSquare2 className="h-3.5 w-3.5" />}
            label="New office"
          />
        </div>

        <ImageUnderlayUpload
          value={backgroundUrl}
          onChange={(url) => {
            setBackgroundUrl(url);
            setDirty(true);
          }}
        />

        <button
          onClick={onSave}
          disabled={!dirty || saving}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-md bg-blue-600 hover:bg-blue-700 text-white shadow-sm disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Save
        </button>
      </div>

      {saveError && (
        <div className="px-4 py-2 text-xs bg-red-50 dark:bg-red-950/40 border-b border-red-200 dark:border-red-900/40 text-red-800 dark:text-red-200">
          Save failed: {saveError}
        </div>
      )}

      {/* Canvas + Inspector */}
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 relative">
          <CanvasEditor
            width={width}
            height={height}
            zones={visibleZones}
            selectedZoneId={selectedZoneId}
            backgroundUrl={backgroundUrl}
            tool={tool}
            onSelectZone={setSelectedZoneId}
            onZonesChange={onZonesChange}
            onDrawComplete={onDrawComplete}
          />
        </div>
        {selected ? (
          <RoomInspector
            zone={selected.zone}
            room={selected.room}
            isNew={selected.isNew}
            onZoneChange={(patch) => onZonePatch(selected.zone.id, patch)}
            onRoomChange={(patch) => onRoomPatch(selected.zone.id, patch)}
            onDelete={() => onDeleteZone(selected.zone.id)}
          />
        ) : (
          <aside className="w-[320px] shrink-0 border-l border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex items-center justify-center p-6 text-center text-xs text-zinc-500">
            <div>
              <Square className="mx-auto h-6 w-6 mb-2 text-zinc-400" />
              <p className="font-medium text-zinc-700 dark:text-zinc-300 mb-1">Nothing selected</p>
              <p>
                Click a zone to edit it, or pick "New room" / "New office" and click-drag on the
                floor.
              </p>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}

function ToolButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={
        active
          ? 'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs bg-blue-600 text-white'
          : 'inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-zinc-700 dark:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-zinc-800'
      }
      title={label}
    >
      {icon}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
