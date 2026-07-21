/**
 * Pure conversion helpers for the Timeline view. Given a project's
 * phases + tasks (the same shape TimelineView already renders), produce
 * portable output in several formats:
 *
 *   - buildGanttSvg(…)          → editable SVG (Illustrator / Inkscape)
 *   - svgToPng(…)               → rasterized PNG at an explicit scale
 *   - buildInstaganttCsv(…)     → wide CSV used by Instagantt, OmniPlan
 *                                  imports, and a couple of Google Sheets
 *                                  gantt templates. Plain enough that
 *                                  anything that wants a gantt CSV will
 *                                  accept it.
 *   - buildMsProjectXml(…)      → MS Project Data Interchange (MSPDI)
 *                                  XML — the format MS Project, Project
 *                                  Libre, and GanttProject all import.
 *   - buildTaskJugglerProject(…) → TaskJuggler .tjp source.
 *
 * The intent is that exports never depend on the visible DOM, so they
 * work at any zoom level, in headless tests, and remain
 * deterministic. PNG/SVG share the same task-bar layout the screen view
 * uses (priority colors, grouping) so a user gets recognizable output.
 */
import {
  addDays,
  differenceInDays,
  format,
  parseISO,
  startOfDay,
} from 'date-fns';
import type { Phase, Task } from '@bigbluebam/shared';
import { neutralizeCsvValue } from '@bigbluebam/shared';

export type GanttGroupBy = 'phase' | 'assignee';
export type GanttColorScheme = 'priority' | 'phase' | 'monochrome';
export type GanttZoom = 'day' | 'week' | 'month';

export interface GanttExportOptions {
  /** Project name, used in chart title + filenames. */
  projectName: string;
  /** Same group-by mode the screen view exposes. */
  groupBy: GanttGroupBy;
  /** Column width zoom. Same enum the screen uses. */
  zoom: GanttZoom;
  /** Pixel width per day. Derived from `zoom` by default; overrideable so
   *  the caller can render a "narrow" or "wide" PNG variant. */
  pxPerDay?: number;
  /** Color scheme for the bars. */
  colorScheme: GanttColorScheme;
  /** When true, includes a today vertical marker line. */
  showTodayMarker?: boolean;
}

const PRIORITY_FILLS: Record<string, string> = {
  critical: '#ef4444',
  high: '#fb923c',
  medium: '#facc15',
  low: '#60a5fa',
  none: '#a1a1aa',
};

const PHASE_FILL_PALETTE = [
  '#0ea5e9', '#22c55e', '#f59e0b', '#a855f7', '#ec4899',
  '#14b8a6', '#f97316', '#84cc16', '#6366f1', '#06b6d4',
];

const MONOCHROME_FILL = '#52525b';

const ROW_H = 28;
const ROW_GAP = 4;
const HEADER_H = 36;
const LABEL_COL_W = 200;
const GROUP_LABEL_H = 28;

function getTaskRange(task: Task): { start: Date; end: Date } | null {
  const startStr = (task as Task & { start_date?: string | null }).start_date;
  const endStr = task.due_date;
  if (startStr && endStr) return { start: parseISO(startStr), end: parseISO(endStr) };
  if (startStr) return { start: parseISO(startStr), end: addDays(parseISO(startStr), 1) };
  if (endStr) return { start: parseISO(endStr), end: addDays(parseISO(endStr), 1) };
  return null;
}

function pxPerDayFor(zoom: GanttZoom): number {
  if (zoom === 'day') return 40;
  if (zoom === 'week') return 120 / 7;
  return 180 / 30;
}

interface GroupRow {
  key: string;
  label: string;
  tasks: Task[];
}

function buildGroups(
  phases: (Phase & { tasks: Task[] })[],
  groupBy: GanttGroupBy,
): GroupRow[] {
  if (groupBy === 'phase') {
    return phases.map((p) => ({ key: p.id, label: p.name, tasks: p.tasks }));
  }
  const byAssignee = new Map<string, GroupRow>();
  for (const t of phases.flatMap((p) => p.tasks)) {
    const key = t.assignee_id ?? '__unassigned__';
    const name = (t as Task & { assignee?: { display_name: string } | null }).assignee?.display_name;
    const label = key === '__unassigned__' ? 'Unassigned' : (name ?? 'Unknown');
    if (!byAssignee.has(key)) byAssignee.set(key, { key, label, tasks: [] });
    byAssignee.get(key)!.tasks.push(t);
  }
  return [...byAssignee.values()].sort((a, b) => {
    if (a.key === '__unassigned__') return 1;
    if (b.key === '__unassigned__') return -1;
    return a.label.localeCompare(b.label);
  });
}

function fillFor(
  task: Task,
  scheme: GanttColorScheme,
  phaseIdToIdx: Map<string, number>,
): string {
  if (scheme === 'priority') return PRIORITY_FILLS[task.priority] ?? PRIORITY_FILLS.none!;
  if (scheme === 'phase') {
    const idx = phaseIdToIdx.get(task.phase_id ?? '') ?? 0;
    return PHASE_FILL_PALETTE[idx % PHASE_FILL_PALETTE.length]!;
  }
  return MONOCHROME_FILL;
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&"']/g, (c) => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '"': return '&quot;';
      case "'": return '&#39;';
    }
    return c;
  });
}

function csvEscape(s: string | number | null | undefined): string {
  // neutralizeCsvValue coerces null/undefined -> '', leaves numbers un-neutralized, and guards
  // string-origin values that begin with a spreadsheet formula trigger (= + - @).
  const str = neutralizeCsvValue(s);
  if (/[,"\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

/** ─────────────────────────────────────────────────────────────────────
 *  SVG (vector — works in Illustrator, Inkscape, browsers, etc.)
 *  ─────────────────────────────────────────────────────────────────── */
export function buildGanttSvg(
  phases: (Phase & { tasks: Task[] })[],
  opts: GanttExportOptions,
): { svg: string; width: number; height: number } {
  const groups = buildGroups(phases, opts.groupBy);
  const allTasks = groups.flatMap((g) => g.tasks);

  if (allTasks.length === 0) {
    const width = LABEL_COL_W + 400;
    const height = HEADER_H + 60;
    return {
      width,
      height,
      svg: `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#ffffff"/><text x="${width / 2}" y="${height / 2}" text-anchor="middle" font-family="system-ui, sans-serif" font-size="14" fill="#71717a">No tasks with dates to chart.</text></svg>`,
    };
  }

  // Bounds
  let earliest: Date | null = null;
  let latest: Date | null = null;
  for (const task of allTasks) {
    const r = getTaskRange(task);
    if (!r) continue;
    if (!earliest || r.start < earliest) earliest = r.start;
    if (!latest || r.end > latest) latest = r.end;
  }
  if (!earliest) earliest = new Date();
  if (!latest) latest = new Date();
  const start = startOfDay(addDays(earliest, -3));
  const end = startOfDay(addDays(latest, 7));
  const totalDays = Math.max(1, differenceInDays(end, start));
  const pxDay = opts.pxPerDay ?? pxPerDayFor(opts.zoom);
  const chartW = totalDays * pxDay;

  // Column ticks
  const tickEvery = opts.zoom === 'day' ? 1 : opts.zoom === 'week' ? 7 : 30;
  const ticks: { x: number; label: string }[] = [];
  for (let d = 0; d <= totalDays; d += tickEvery) {
    const date = addDays(start, d);
    ticks.push({
      x: d * pxDay,
      label: opts.zoom === 'month' ? format(date, 'MMM yyyy') : format(date, 'MMM d'),
    });
  }

  const phaseIdToIdx = new Map<string, number>(phases.map((p, i) => [p.id, i]));

  // Layout
  let cursorY = HEADER_H;
  const rowMeta: { y: number; group: GroupRow; taskYs: { task: Task; y: number }[] }[] = [];
  for (const group of groups) {
    const groupY = cursorY;
    cursorY += GROUP_LABEL_H;
    const taskYs: { task: Task; y: number }[] = [];
    for (const t of group.tasks) {
      taskYs.push({ task: t, y: cursorY });
      cursorY += ROW_H + ROW_GAP;
    }
    rowMeta.push({ y: groupY, group, taskYs });
    cursorY += 8; // group spacing
  }
  const height = cursorY + 12;
  const width = LABEL_COL_W + chartW + 16;

  const todayX =
    opts.showTodayMarker !== false
      ? differenceInDays(startOfDay(new Date()), start) * pxDay
      : null;

  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="system-ui, -apple-system, sans-serif">`,
  );
  parts.push(`<rect width="100%" height="100%" fill="#ffffff"/>`);
  // Title
  parts.push(
    `<text x="12" y="22" font-size="14" font-weight="600" fill="#18181b">${xmlEscape(opts.projectName)} — Timeline (${opts.zoom})</text>`,
  );
  // Column header background
  parts.push(`<rect x="${LABEL_COL_W}" y="${HEADER_H - 18}" width="${chartW}" height="18" fill="#f4f4f5"/>`);
  // Ticks
  for (const tick of ticks) {
    const tx = LABEL_COL_W + tick.x;
    parts.push(
      `<line x1="${tx}" y1="${HEADER_H}" x2="${tx}" y2="${height - 8}" stroke="#e4e4e7" stroke-width="1"/>`,
    );
    parts.push(
      `<text x="${tx + 2}" y="${HEADER_H - 5}" font-size="9" fill="#52525b">${xmlEscape(tick.label)}</text>`,
    );
  }
  // Today marker
  if (todayX != null && todayX >= 0 && todayX <= chartW) {
    parts.push(
      `<line x1="${LABEL_COL_W + todayX}" y1="${HEADER_H}" x2="${LABEL_COL_W + todayX}" y2="${height - 8}" stroke="#ef4444" stroke-width="1.5" stroke-dasharray="3 2"/>`,
    );
  }

  // Rows
  for (const meta of rowMeta) {
    parts.push(
      `<text x="8" y="${meta.y + 18}" font-size="12" font-weight="600" fill="#3f3f46">${xmlEscape(meta.group.label)}</text>`,
    );
    for (const { task, y } of meta.taskYs) {
      const range = getTaskRange(task);
      const fill = fillFor(task, opts.colorScheme, phaseIdToIdx);
      const label = `${task.human_id ?? ''} ${task.title}`;
      parts.push(
        `<text x="${LABEL_COL_W - 8}" y="${y + ROW_H / 2 + 4}" font-size="10" text-anchor="end" fill="#52525b">${xmlEscape(label.length > 26 ? `${label.slice(0, 26)}…` : label)}</text>`,
      );
      if (range) {
        const xStart = LABEL_COL_W + Math.max(0, differenceInDays(range.start, start) * pxDay);
        const xEnd = LABEL_COL_W + Math.min(chartW, differenceInDays(range.end, start) * pxDay);
        const w = Math.max(4, xEnd - xStart);
        parts.push(
          `<rect x="${xStart}" y="${y + 4}" width="${w}" height="${ROW_H - 8}" rx="3" fill="${fill}" stroke="#27272a" stroke-opacity="0.25"/>`,
        );
        if (w > 60) {
          parts.push(
            `<text x="${xStart + 4}" y="${y + ROW_H / 2 + 4}" font-size="9" fill="#ffffff" font-weight="600">${xmlEscape(task.title.length > 22 ? `${task.title.slice(0, 22)}…` : task.title)}</text>`,
          );
        }
      } else {
        // No dates: small diamond at the row's far left in the chart area.
        const cx = LABEL_COL_W + 12;
        const cy = y + ROW_H / 2;
        parts.push(
          `<polygon points="${cx},${cy - 5} ${cx + 5},${cy} ${cx},${cy + 5} ${cx - 5},${cy}" fill="${fill}" opacity="0.6"/>`,
        );
      }
    }
  }

  parts.push(`</svg>`);
  return { svg: parts.join(''), width, height };
}

/** ─────────────────────────────────────────────────────────────────────
 *  SVG → PNG via a temporary canvas. Renders at 2x by default so screen
 *  output stays sharp on Retina displays.
 *  ─────────────────────────────────────────────────────────────────── */
export async function svgToPng(
  svg: string,
  width: number,
  height: number,
  scale = 2,
): Promise<Blob> {
  const blobIn = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blobIn);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = (e) => reject(e);
      el.src = url;
    });
    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context unavailable.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.drawImage(img, 0, 0);
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('Canvas could not produce PNG blob.'))),
        'image/png',
      );
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** ─────────────────────────────────────────────────────────────────────
 *  Generic gantt CSV — accepted by Instagantt, GanttProject (CSV import),
 *  the GitHub gantt-csv flavors, Smartsheet, and pretty much every
 *  spreadsheet template you can find. Bam doesn't model task
 *  dependencies, so the Predecessors column is left blank; the parent
 *  link is exposed via WBS-style hierarchy.
 *  ─────────────────────────────────────────────────────────────────── */
export function buildGanttCsv(
  phases: (Phase & { tasks: Task[] })[],
  projectName: string,
): string {
  const lines: string[] = [];
  lines.push([
    'Task ID',
    'Task Name',
    'Start Date',
    'End Date',
    'Duration (days)',
    'Phase',
    'Assignee',
    'Priority',
    'State',
    'Story Points',
    'Predecessors',
    'Notes',
  ].join(','));
  const phaseNameById = new Map(phases.map((p) => [p.id, p.name]));
  for (const phase of phases) {
    for (const task of phase.tasks) {
      const range = getTaskRange(task);
      const start = range ? format(range.start, 'yyyy-MM-dd') : '';
      const end = range ? format(range.end, 'yyyy-MM-dd') : '';
      const dur = range ? Math.max(1, differenceInDays(range.end, range.start)) : '';
      const assignee = (task as Task & { assignee?: { display_name: string } | null }).assignee?.display_name ?? '';
      lines.push([
        csvEscape(task.human_id),
        csvEscape(task.title),
        csvEscape(start),
        csvEscape(end),
        csvEscape(dur),
        csvEscape(phaseNameById.get(task.phase_id ?? '') ?? ''),
        csvEscape(assignee),
        csvEscape(task.priority),
        csvEscape(task.state_id ?? ''),
        csvEscape(task.story_points ?? ''),
        '',
        csvEscape(projectName),
      ].join(','));
    }
  }
  return lines.join('\n');
}

/** ─────────────────────────────────────────────────────────────────────
 *  Microsoft Project Data Interchange (MSPDI) — the XML schema that
 *  MS Project, ProjectLibre, OpenProj, and GanttProject all import.
 *  We emit a minimal valid project so the user gets every task as a
 *  separate <Task> with Start/Finish. Bam has no dependencies so
 *  the <PredecessorLink> set is empty. UID/ID assignment follows the
 *  task ordering across all phases (MS Project requires monotonic IDs).
 *  ─────────────────────────────────────────────────────────────────── */
export function buildMsProjectXml(
  phases: (Phase & { tasks: Task[] })[],
  projectName: string,
): string {
  const now = new Date().toISOString().replace(/\..*/, '');
  const allTasks: { task: Task; phaseName: string }[] = [];
  for (const phase of phases) {
    for (const task of phase.tasks) {
      allTasks.push({ task, phaseName: phase.name });
    }
  }
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  lines.push('<Project xmlns="http://schemas.microsoft.com/project">');
  lines.push(`  <Name>${xmlEscape(projectName)}</Name>`);
  lines.push(`  <Title>${xmlEscape(projectName)}</Title>`);
  lines.push(`  <CreationDate>${now}</CreationDate>`);
  lines.push('  <Tasks>');
  let uid = 0;
  for (const { task, phaseName } of allTasks) {
    uid += 1;
    const range = getTaskRange(task);
    const startISO = range ? `${format(range.start, "yyyy-MM-dd'T'HH:mm:ss")}` : `${now}`;
    const endISO = range ? `${format(range.end, "yyyy-MM-dd'T'HH:mm:ss")}` : `${now}`;
    lines.push('    <Task>');
    lines.push(`      <UID>${uid}</UID>`);
    lines.push(`      <ID>${uid}</ID>`);
    lines.push(`      <Name>${xmlEscape(`[${task.human_id ?? ''}] ${task.title} (${phaseName})`)}</Name>`);
    lines.push(`      <Start>${startISO}</Start>`);
    lines.push(`      <Finish>${endISO}</Finish>`);
    lines.push(`      <Priority>${{ critical: 1000, high: 750, medium: 500, low: 250, none: 100 }[task.priority] ?? 500}</Priority>`);
    if (task.story_points != null) {
      lines.push(`      <Work>PT${task.story_points}H0M0S</Work>`);
    }
    lines.push('    </Task>');
  }
  lines.push('  </Tasks>');
  lines.push('</Project>');
  return lines.join('\n');
}

/** ─────────────────────────────────────────────────────────────────────
 *  TaskJuggler `.tjp` source. Optional but cheap to produce.
 *  ─────────────────────────────────────────────────────────────────── */
export function buildTaskJugglerProject(
  phases: (Phase & { tasks: Task[] })[],
  projectName: string,
): string {
  const tjpId = projectName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'project';
  // Bounds
  let earliest: Date | null = null;
  let latest: Date | null = null;
  for (const phase of phases) {
    for (const task of phase.tasks) {
      const range = getTaskRange(task);
      if (!range) continue;
      if (!earliest || range.start < earliest) earliest = range.start;
      if (!latest || range.end > latest) latest = range.end;
    }
  }
  const start = format(earliest ?? new Date(), 'yyyy-MM-dd');
  const end = format(latest ?? addDays(new Date(), 30), 'yyyy-MM-dd');

  const lines: string[] = [];
  lines.push(`project ${tjpId} "${projectName}" ${start} - ${end} {`);
  lines.push('  timezone "UTC"');
  lines.push('  timeformat "%Y-%m-%d"');
  lines.push('}');
  lines.push('');
  for (let i = 0; i < phases.length; i++) {
    const phase = phases[i]!;
    lines.push(`task ${tjpId}_p${i} "${phase.name}" {`);
    for (let j = 0; j < phase.tasks.length; j++) {
      const task = phase.tasks[j]!;
      const range = getTaskRange(task);
      lines.push(`  task ${tjpId}_p${i}_t${j} "${(task.title || 'Untitled').replace(/"/g, "'")}" {`);
      if (range) {
        lines.push(`    start ${format(range.start, 'yyyy-MM-dd')}`);
        lines.push(`    end ${format(range.end, 'yyyy-MM-dd')}`);
      }
      const priorityMap: Record<string, number> = { critical: 1000, high: 750, medium: 500, low: 250, none: 100 };
      lines.push(`    priority ${priorityMap[task.priority] ?? 500}`);
      lines.push('  }');
    }
    lines.push('}');
  }
  return lines.join('\n');
}

/** Helper: blob downloader with a sane filename. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/** Slug a project name into something safe for filenames. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'project';
}
