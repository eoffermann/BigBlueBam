/**
 * Right-side properties panel for the floor editor.
 *
 * Mirrors the room-row contract in apps/bureau-api/src/routes/rooms.routes.ts
 * (name, type, capacity, privacy_default, bookable, zone_id, owner_id) plus
 * the geometry rectangle from the zone.
 *
 * Owner selection uses the shared PeoplePicker (see
 * ../common/people-picker.tsx) which fetches /b3/api/org/members and
 * filters client-side. The "view in /b3/people" link stays as an escape
 * hatch for editing the user record itself.
 */

import { useEffect, useState } from 'react';
import { ExternalLink, Trash2 } from 'lucide-react';
import { PeoplePicker } from '../common/people-picker';
import type { Zone, ZoneKind } from './zone-types';

const ROOM_TYPES = [
  { value: 'office', label: 'Office (single owner)' },
  { value: 'huddle', label: 'Huddle' },
  { value: 'conference', label: 'Conference' },
  { value: 'meeting', label: 'Meeting' },
  { value: 'open', label: 'Open space' },
  { value: 'lounge', label: 'Lounge' },
  { value: 'focus', label: 'Focus' },
  { value: 'lobby', label: 'Lobby' },
] as const;

const PRIVACY_OPTIONS = [
  { value: 'open', label: 'Open' },
  { value: 'knock', label: 'Knock' },
  { value: 'private', label: 'Private' },
] as const;

export interface RoomProperties {
  name: string;
  type: (typeof ROOM_TYPES)[number]['value'];
  capacity: number | null;
  privacy_default: (typeof PRIVACY_OPTIONS)[number]['value'];
  bookable: boolean;
  owner_id: string | null;
}

export interface RoomInspectorProps {
  zone: Zone;
  /** Existing room row matched to this zone, if any. */
  room: RoomProperties | null;
  /** True when the zone has no matching `bureau_rooms` row yet. */
  isNew: boolean;
  onZoneChange: (patch: Partial<Pick<Zone, 'label' | 'x' | 'y' | 'w' | 'h' | 'kind'>>) => void;
  onRoomChange: (patch: Partial<RoomProperties>) => void;
  onDelete: () => void;
}

export function RoomInspector({
  zone,
  room,
  isNew,
  onZoneChange,
  onRoomChange,
  onDelete,
}: RoomInspectorProps) {
  // Local mirror of the name field so we can debounce updates without
  // re-rendering the canvas on every keystroke.
  const [nameInput, setNameInput] = useState(zone.label || room?.name || '');
  useEffect(() => {
    setNameInput(zone.label || room?.name || '');
  }, [zone.id, zone.label, room?.name]);

  // Capacity local mirror — same reasoning.
  const [capacityInput, setCapacityInput] = useState<string>(
    room?.capacity != null ? String(room.capacity) : '',
  );
  useEffect(() => {
    setCapacityInput(room?.capacity != null ? String(room.capacity) : '');
  }, [zone.id, room?.capacity]);

  const commitName = () => {
    const v = nameInput.trim();
    if (v === (zone.label || '')) return;
    onZoneChange({ label: v });
    onRoomChange({ name: v });
  };

  const commitCapacity = () => {
    const trimmed = capacityInput.trim();
    if (trimmed === '') {
      if (room?.capacity != null) onRoomChange({ capacity: null });
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 1) {
      // Reset the input to the last good value.
      setCapacityInput(room?.capacity != null ? String(room.capacity) : '');
      return;
    }
    onRoomChange({ capacity: Math.floor(n) });
  };

  const isOffice = (room?.type ?? (zone.kind === 'office' ? 'office' : 'open')) === 'office';

  return (
    <aside className="h-full w-[320px] shrink-0 border-l border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950 flex flex-col">
      <header className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-800">
        <div className="text-xs uppercase tracking-wider text-zinc-500">
          {isNew ? 'New zone (not saved)' : 'Room'}
        </div>
        <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 truncate">
          {zone.label || (zone.kind === 'office' ? 'Untitled office' : 'Untitled room')}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 text-xs">
        {/* Name ---------------------------------------------------- */}
        <Field label="Name">
          <input
            className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm text-zinc-900 dark:text-zinc-100"
            value={nameInput}
            onChange={(e) => setNameInput(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
            }}
            placeholder="e.g. War Room"
          />
        </Field>

        {/* Type ---------------------------------------------------- */}
        <Field label="Type">
          <select
            className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm text-zinc-900 dark:text-zinc-100"
            value={room?.type ?? (zone.kind === 'office' ? 'office' : 'open')}
            onChange={(e) => {
              const type = e.target.value as RoomProperties['type'];
              onRoomChange({ type });
              // Keep the zone kind label in sync so the canvas re-tints.
              const nextKind: ZoneKind = type === 'office' ? 'office' : 'room';
              if (nextKind !== zone.kind) onZoneChange({ kind: nextKind });
            }}
          >
            {ROOM_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </Field>

        {/* Capacity ------------------------------------------------ */}
        <Field label="Capacity (people)">
          <input
            type="number"
            min={1}
            className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm text-zinc-900 dark:text-zinc-100"
            value={capacityInput}
            placeholder="(unlimited)"
            onChange={(e) => setCapacityInput(e.target.value)}
            onBlur={commitCapacity}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
            }}
          />
        </Field>

        {/* Privacy ------------------------------------------------- */}
        <Field label="Door default">
          <select
            className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm text-zinc-900 dark:text-zinc-100"
            value={room?.privacy_default ?? 'open'}
            onChange={(e) =>
              onRoomChange({ privacy_default: e.target.value as RoomProperties['privacy_default'] })
            }
          >
            {PRIVACY_OPTIONS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-zinc-500">
            The default — visitors override this at runtime via the docked box.
          </p>
        </Field>

        {/* Bookable ------------------------------------------------ */}
        <Field label="Bookable">
          <label className="inline-flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-200 cursor-pointer">
            <input
              type="checkbox"
              checked={!!room?.bookable}
              onChange={(e) => onRoomChange({ bookable: e.target.checked })}
              className="h-4 w-4"
            />
            <span>Allow reservations via Book</span>
          </label>
        </Field>

        {/* Owner (offices only) ----------------------------------- */}
        {isOffice && (
          <Field label="Owner">
            <PeoplePicker
              value={room?.owner_id ?? null}
              onChange={(userId) => {
                if (userId === (room?.owner_id ?? null)) return;
                onRoomChange({ owner_id: userId });
              }}
              placeholder="Choose owner…"
            />
            <a
              href={
                room?.owner_id
                  ? `/b3/people/${room.owner_id}`
                  : '/b3/people'
              }
              target="_blank"
              rel="noreferrer"
              className="mt-1 inline-flex items-center gap-1 text-[11px] text-blue-600 hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              {room?.owner_id ? 'View owner in People' : 'Open People directory'}
            </a>
          </Field>
        )}

        {/* Geometry ----------------------------------------------- */}
        <Field label="Geometry (world units)">
          <div className="grid grid-cols-2 gap-2">
            <NumInput
              label="x"
              value={zone.x}
              min={0}
              onCommit={(n) => onZoneChange({ x: n })}
            />
            <NumInput
              label="y"
              value={zone.y}
              min={0}
              onCommit={(n) => onZoneChange({ y: n })}
            />
            <NumInput
              label="w"
              value={zone.w}
              min={24}
              onCommit={(n) => onZoneChange({ w: n })}
            />
            <NumInput
              label="h"
              value={zone.h}
              min={24}
              onCommit={(n) => onZoneChange({ h: n })}
            />
          </div>
        </Field>

        {/* Zone id (read-only, useful for debugging) -------------- */}
        <Field label="Zone id">
          <code className="block w-full rounded-md border border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-900 px-2 py-1 text-[11px] text-zinc-500 font-mono break-all">
            {zone.id}
          </code>
        </Field>
      </div>

      <footer className="px-4 py-3 border-t border-zinc-200 dark:border-zinc-800">
        <button
          onClick={onDelete}
          className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 text-xs rounded-md border border-red-200 dark:border-red-900/50 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30"
        >
          <Trash2 className="h-3.5 w-3.5" /> Remove zone
        </button>
        <p className="mt-2 text-[10px] text-zinc-500 leading-tight">
          {isNew
            ? 'Removes this zone from the layout. Nothing has been saved yet.'
            : 'Soft-deletes the matched room on save. Live occupants are evicted to the lobby.'}
        </p>
      </footer>
    </aside>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-[11px] uppercase tracking-wider text-zinc-500 mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}

function NumInput({
  label,
  value,
  min,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  onCommit: (n: number) => void;
}) {
  const [local, setLocal] = useState(String(value));
  useEffect(() => setLocal(String(value)), [value]);
  return (
    <label className="block">
      <span className="block text-[10px] text-zinc-500">{label}</span>
      <input
        type="number"
        min={min}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        onBlur={() => {
          const n = Number(local);
          if (!Number.isFinite(n) || n < min) {
            setLocal(String(value));
            return;
          }
          onCommit(Math.round(n));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
        }}
        className="w-full rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm text-zinc-900 dark:text-zinc-100"
      />
    </label>
  );
}
