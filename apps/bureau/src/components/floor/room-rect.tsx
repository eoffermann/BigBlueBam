/**
 * Canvas2D drawing primitives for the floor view.
 *
 * Exports a single function `drawRoomRect()` that takes a CanvasRenderingContext2D,
 * a rectangle in floor-coordinate space, the room name/capacity label, and a
 * list of occupant ids. It paints the rectangle frame, the label header, and a
 * grid of occupant dots inside.
 *
 * The renderer is intentionally framework-free: floor-view.tsx hands it the
 * context every frame and we draw. No virtual-DOM, no per-room React node.
 */

import { colorForUserId } from '@/lib/utils';
import type { FloorLayoutRect } from '@/stores/bureau-store';

export interface DrawRoomRectOptions {
  rect: FloorLayoutRect;
  name: string;
  capacity?: number | null;
  occupants: string[];
  /** Mark the room the local user is currently in. */
  isSelf?: boolean;
  /** Hover state from mouse-tracking in the parent. */
  isHover?: boolean;
  /** Dark-mode flag (drives stroke/fill choices). */
  isDark?: boolean;
}

/**
 * Maximum dots we paint per room. After this we paint a "+N" badge instead
 * of additional dots to keep the visual cheap.
 */
const MAX_DOTS = 24;
const DOT_RADIUS = 5;
const DOT_GAP = 3;

export function drawRoomRect(
  ctx: CanvasRenderingContext2D,
  opts: DrawRoomRectOptions,
): void {
  const { rect, name, capacity, occupants, isSelf, isHover, isDark } = opts;
  const { x, y, w, h } = rect;

  // ── Rectangle ───────────────────────────────────────────────
  ctx.beginPath();
  // 8px corner radius via roundRect when available, else fall back to rect.
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, 8);
  } else {
    ctx.rect(x, y, w, h);
  }
  ctx.fillStyle = isDark
    ? isSelf
      ? 'rgba(37, 99, 235, 0.18)'
      : 'rgba(39, 39, 42, 0.6)'
    : isSelf
      ? 'rgba(37, 99, 235, 0.10)'
      : 'rgba(255, 255, 255, 0.85)';
  ctx.fill();
  ctx.lineWidth = isHover ? 2 : 1.25;
  ctx.strokeStyle = isSelf
    ? '#2563eb'
    : isDark
      ? '#52525b'
      : '#a1a1aa';
  ctx.stroke();

  // ── Label header ────────────────────────────────────────────
  const headerH = 22;
  ctx.save();
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    // Header only top-rounded corners — emulate with clip.
    ctx.rect(x, y, w, headerH);
  } else {
    ctx.rect(x, y, w, headerH);
  }
  ctx.clip();
  ctx.fillStyle = isDark ? 'rgba(63, 63, 70, 0.7)' : 'rgba(244, 244, 245, 0.95)';
  ctx.fillRect(x, y, w, headerH);
  ctx.restore();

  ctx.fillStyle = isDark ? '#fafafa' : '#18181b';
  ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  ctx.textBaseline = 'middle';
  const labelText = capacity != null ? `${name}  (${occupants.length}/${capacity})` : `${name}  (${occupants.length})`;
  // Truncate to fit width.
  const maxLabelWidth = w - 16;
  let label = labelText;
  if (ctx.measureText(label).width > maxLabelWidth) {
    while (label.length > 1 && ctx.measureText(`${label}…`).width > maxLabelWidth) {
      label = label.slice(0, -1);
    }
    label = `${label}…`;
  }
  ctx.fillText(label, x + 8, y + headerH / 2);

  // ── Occupant dots grid ──────────────────────────────────────
  const dotsAreaX = x + 8;
  const dotsAreaY = y + headerH + 6;
  const dotsAreaW = w - 16;
  const dotsAreaH = h - headerH - 12;
  if (dotsAreaW <= 0 || dotsAreaH <= 0) return;

  const slotSize = DOT_RADIUS * 2 + DOT_GAP;
  const cols = Math.max(1, Math.floor(dotsAreaW / slotSize));
  const drawCount = Math.min(occupants.length, MAX_DOTS);
  for (let i = 0; i < drawCount; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx = dotsAreaX + col * slotSize + DOT_RADIUS;
    const cy = dotsAreaY + row * slotSize + DOT_RADIUS;
    if (cy + DOT_RADIUS > dotsAreaY + dotsAreaH) break;
    const userId = occupants[i]!;
    ctx.beginPath();
    ctx.arc(cx, cy, DOT_RADIUS, 0, Math.PI * 2);
    ctx.fillStyle = colorForUserId(userId);
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = isDark ? '#18181b' : '#ffffff';
    ctx.stroke();
  }

  if (occupants.length > drawCount) {
    const extra = occupants.length - drawCount;
    ctx.fillStyle = isDark ? '#a1a1aa' : '#52525b';
    ctx.font = '600 10px system-ui, sans-serif';
    ctx.textBaseline = 'top';
    ctx.fillText(`+${extra}`, dotsAreaX, dotsAreaY + dotsAreaH - 12);
  }
}

/**
 * Hit-test a point against a rectangle. Used by floor-view to find which
 * room the user clicked.
 */
export function hitTestRect(rect: FloorLayoutRect, px: number, py: number): boolean {
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h;
}
