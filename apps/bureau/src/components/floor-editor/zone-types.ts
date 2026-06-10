/**
 * Shared types between the floor-editor page and its child components.
 *
 * The floor's layout JSONB on the server has the shape
 *   {
 *     width:  number,
 *     height: number,
 *     zones:  Zone[],
 *     walls:  unknown[]
 *   }
 *
 * (See infra/postgres/migrations/0177_bureau_seed_demo_floor.sql for the
 * canonical seed instance and bureau-api floors.routes.ts for how it's
 * round-tripped on PATCH.)
 *
 * Each room/office row in `bureau_rooms` references a zone via its
 * `zone_id` column. The editor only owns the geometry layer; the
 * inspector handles the per-room properties that live on the row itself.
 */

export type ZoneKind = 'room' | 'office';

/**
 * A geometry rectangle on a floor. `kind` is editor-side metadata that
 * mirrors the eventual `bureau_rooms.type` ('office' vs anything else)
 * so the canvas can paint offices distinctly before the room row is
 * created server-side.
 */
export interface Zone {
  id: string;
  /** Mirrors `bureau_rooms.name` / the room name. */
  label: string;
  /** Mirrors the eventual room type — 'office' is single-user. */
  kind: ZoneKind;
  /** Always 'rect' for v1; future shapes (polygon) reserved. */
  shape: 'rect';
  /** World-space top-left. */
  x: number;
  y: number;
  /** World-space size. */
  w: number;
  h: number;
}

export interface FloorLayout {
  width: number;
  height: number;
  zones: Zone[];
  walls: unknown[];
}

/**
 * Coerces an arbitrary parsed-JSON layout into a FloorLayout, dropping
 * malformed zones. We're pragmatic: the seed format is canonical, but
 * older floors written by hand can still be opened safely.
 */
export function normalizeLayout(raw: unknown): FloorLayout {
  const obj = (raw ?? {}) as Record<string, unknown>;
  const width = typeof obj.width === 'number' && obj.width > 0 ? obj.width : 1200;
  const height = typeof obj.height === 'number' && obj.height > 0 ? obj.height : 800;
  const zonesRaw = Array.isArray(obj.zones) ? obj.zones : [];
  const zones: Zone[] = [];
  for (const z of zonesRaw) {
    if (!z || typeof z !== 'object') continue;
    const o = z as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.x !== 'number' || typeof o.y !== 'number') continue;
    const w = typeof o.w === 'number' ? o.w : 0;
    const h = typeof o.h === 'number' ? o.h : 0;
    if (w <= 0 || h <= 0) continue;
    const label = typeof o.label === 'string' ? o.label : '';
    const kind: ZoneKind = label.toLowerCase().includes('office') ? 'office' : 'room';
    zones.push({
      id: o.id,
      label,
      kind,
      shape: 'rect',
      x: o.x,
      y: o.y,
      w,
      h,
    });
  }
  const walls = Array.isArray(obj.walls) ? obj.walls : [];
  return { width, height, zones, walls };
}

/**
 * Serializes back into the on-disk JSONB shape, preserving the canonical
 * key order ({width, height, zones, walls}) and trimming editor-only
 * fields. `kind` is encoded back into the label only — server-side the
 * room row already carries `type`.
 */
export function serializeLayout(layout: FloorLayout): Record<string, unknown> {
  return {
    width: layout.width,
    height: layout.height,
    zones: layout.zones.map((z) => ({
      id: z.id,
      shape: z.shape,
      x: z.x,
      y: z.y,
      w: z.w,
      h: z.h,
      label: z.label,
    })),
    walls: layout.walls,
  };
}

/**
 * Stable id generator for newly-drawn zones. We want something that's
 * unique and traceable in db logs without needing a uuid lib.
 */
export function newZoneId(): string {
  const r = Math.random().toString(36).slice(2, 8);
  return `zone-${Date.now().toString(36)}-${r}`;
}
