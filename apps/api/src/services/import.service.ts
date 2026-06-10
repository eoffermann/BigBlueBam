import { eq, and, sql, asc } from 'drizzle-orm';
import type { CreateTaskInput, TaskLinkInput, TaskLink, UpdateTaskInput } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { tasks } from '../db/schema/tasks.js';
import { phases } from '../db/schema/phases.js';
import { labels } from '../db/schema/labels.js';
import { users } from '../db/schema/users.js';
import { customFieldDefinitions } from '../db/schema/custom-fields.js';
import { createTask, updateTask } from './task.service.js';

/**
 * CSV import core (csv-import plan §5.1–§5.3, §5.7).
 *
 * Extracted out of import.routes.ts so the row-processing loop is reusable
 * between the commit endpoint (runImport) and the dry-run endpoint
 * (previewImport), and later the bam_import_csv MCP tool.
 *
 * Backward-compatible with the original wire format: `rows` + `mapping`
 * behave exactly as before. The new optional fields — value_maps,
 * link_mappings, options.duplicate_strategy — layer on top.
 *
 * Task creation delegates to task.service.createTask so the Links field
 * (Phase 0) — internal-URL title resolution, entity_links mirroring, async
 * external title fetch — is consumed, not re-implemented: a link is imported
 * simply by passing it in the `links` array.
 */

// ── shared find-or-create helpers (moved out of import.routes.ts) ─────────

export async function findOrCreatePhase(projectId: string, name: string) {
  const [existing] = await db
    .select()
    .from(phases)
    .where(and(eq(phases.project_id, projectId), eq(phases.name, name)))
    .limit(1);

  if (existing) return existing;

  const maxPos = await db
    .select({ max: sql<number>`coalesce(max(${phases.position}), 0)` })
    .from(phases)
    .where(eq(phases.project_id, projectId));

  const [created] = await db
    .insert(phases)
    .values({
      project_id: projectId,
      name,
      position: (maxPos[0]?.max ?? 0) + 1,
    })
    .returning();

  return created!;
}

export async function findOrCreateLabel(projectId: string, name: string, color?: string) {
  const [existing] = await db
    .select()
    .from(labels)
    .where(and(eq(labels.project_id, projectId), eq(labels.name, name)))
    .limit(1);

  if (existing) return existing;

  const [created] = await db
    .insert(labels)
    .values({
      project_id: projectId,
      name,
      color: color ?? null,
    })
    .returning();

  return created!;
}

export async function findUserByEmail(email: string) {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email.toLowerCase().trim()))
    .limit(1);

  return user ?? null;
}

export async function getDefaultPhase(projectId: string) {
  const [phase] = await db
    .select()
    .from(phases)
    .where(and(eq(phases.project_id, projectId), eq(phases.is_start, true)))
    .limit(1);

  if (phase) return phase;

  // Fallback: first phase by position
  const [first] = await db
    .select()
    .from(phases)
    .where(eq(phases.project_id, projectId))
    .orderBy(asc(phases.position))
    .limit(1);

  return first ?? null;
}

// ── priority normalization ────────────────────────────────────────────────

const JIRA_PRIORITY_MAP: Record<string, string> = {
  Highest: 'critical',
  High: 'high',
  Medium: 'medium',
  Low: 'low',
  Lowest: 'low',
};

const VALID_PRIORITIES = ['critical', 'high', 'medium', 'low'];

export function normalizePriority(value: string | undefined | null): string {
  if (!value) return 'medium';
  const lower = value.toLowerCase().trim();
  if (VALID_PRIORITIES.includes(lower)) return lower;
  return JIRA_PRIORITY_MAP[value] ?? 'medium';
}

// ── wire types ────────────────────────────────────────────────────────────

export type DuplicateStrategy = 'create' | 'skip' | 'update';

export type DateLocale = 'us' | 'iso';

/** The seven custom-field types the platform supports. */
export type CustomFieldType =
  | 'text'
  | 'number'
  | 'date'
  | 'select'
  | 'multi_select'
  | 'checkbox'
  | 'url';

export interface LinkMapping {
  column: string;
  label?: string | null;
  fetch_title?: boolean;
}

/**
 * Opt-in custom-field column mapping (csv-import plan §5.2 / G3). Each entry
 * maps one CSV column into a project custom field. `create_if_missing`
 * find-or-creates the `custom_field_definition` (by name within the project);
 * otherwise the column is only written when a matching definition already
 * exists. The default posture for an unmapped column stays *ignore* — this
 * list is built only from explicit user choices in the wizard.
 */
export interface CustomFieldMapping {
  column: string;
  field_name: string;
  field_type: CustomFieldType;
  create_if_missing?: boolean;
}

export interface ImportBody {
  rows: Record<string, string>[];
  mapping: Record<string, string>;
  value_maps?: Record<string, Record<string, string | null>>;
  link_mappings?: LinkMapping[];
  custom_field_mapping?: CustomFieldMapping[];
  options?: { duplicate_strategy?: DuplicateStrategy; date_locale?: DateLocale };
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

/** A per-cell coercion warning (does NOT fail the row). */
export interface CellWarning {
  row: number;
  column: string;
  value: string;
  reason: string;
}

export interface PreviewResult {
  total_rows: number;
  will_create: number;
  will_skip: number;
  // ── update strategy (Phase 3, §5.2 / §8) ─────────────────────────────────
  // Count of rows that, under duplicate_strategy:'update', match an existing
  // task and will overwrite it (rather than create or skip). Always present;
  // 0 under create/skip. `update_matches` lists each matched row with the
  // task it resolved to and how (human_id vs title).
  will_update: number;
  update_matches: { row: number; human_id: string | null; matched_by: 'human_id' | 'title' }[];
  new_phases: string[];
  new_labels: string[];
  new_custom_fields: { name: string; field_type: CustomFieldType; inferred_options?: string[] }[];
  unmapped_values: Record<string, string[]>;
  unresolved_assignees: { row: number; value: string }[];
  invalid_urls: { row: number; column: string; value: string }[];
  cell_warnings: CellWarning[];
  duplicate_titles: { row: number; title: string }[];
}

// ── value-map resolution (§5.2) ────────────────────────────────────────────

/**
 * Apply a per-field value map to an incoming cell.
 *
 * Returns one of:
 *   - { mapped: true, value: string }  → use the mapped Bam value
 *   - { mapped: true, value: null }    → mapped to null: leave the field unset
 *   - { mapped: false }                → not in the map: passthrough (caller
 *                                          applies field-specific default
 *                                          behavior, e.g. find-or-create or the
 *                                          priority normalizer)
 *
 * Matching is exact-after-trim, case-insensitive.
 */
export function applyValueMap(
  field: string,
  cell: string,
  valueMaps: ImportBody['value_maps'],
): { mapped: true; value: string | null } | { mapped: false } {
  const map = valueMaps?.[field];
  if (!map) return { mapped: false };
  const key = cell.trim().toLowerCase();
  for (const [incoming, target] of Object.entries(map)) {
    if (incoming.trim().toLowerCase() === key) {
      return { mapped: true, value: target };
    }
  }
  return { mapped: false };
}

// ── link-mapping parsing (§5.2) ────────────────────────────────────────────

/**
 * Split a link cell into individual URLs, prepend https:// to bare domains,
 * and validate. Returns parsed URLs and the raw tokens that failed validation
 * (so preview can surface them).
 *
 * Two cell shapes are accepted so the export round-trips (plan §5.7):
 *   - The CSV export emits "Title <url>; Title2 <url2>" (see
 *     export.routes.ts formatLinksForCsv). When angle-bracketed URLs are
 *     present we extract ONLY what's inside the brackets — the surrounding
 *     title words are export labels, not URLs, and must not become junk
 *     invalid tokens.
 *   - A hand-typed cell with one or more bare/absolute URLs separated by
 *     whitespace, commas, or semicolons.
 */
function parseLinkCell(cell: string): { urls: string[]; invalid: string[] } {
  const bracketed = [...cell.matchAll(/<([^>]+)>/g)].map((m) => m[1]!.trim());
  const tokens =
    bracketed.length > 0
      ? bracketed
      : cell
          .split(/[\s,;]+/)
          .map((t) => t.trim())
          .filter(Boolean);
  const urls: string[] = [];
  const invalid: string[] = [];
  for (const token of tokens) {
    const normalized = normalizeLinkToken(token);
    if (normalized) {
      urls.push(normalized);
    } else {
      invalid.push(token);
    }
  }
  return { urls, invalid };
}

/**
 * Normalize a single link token: prepend https:// to bare domains, then
 * validate as an http(s) URL. Returns the normalized URL, or null if it is
 * not URL-ish (e.g. "see Bob").
 */
function normalizeLinkToken(token: string): string | null {
  let candidate = token;
  // Bare domain (no scheme): something like "example.com/path". Require a dot
  // and no whitespace; reject obvious non-URLs.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)) {
    if (!/^[^\s/]+\.[^\s/]+/.test(candidate)) return null;
    candidate = `https://${candidate}`;
  }
  try {
    const u = new URL(candidate);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    // Return the candidate as-written (only the scheme prepend is applied) so
    // we don't mutate user URLs — new URL().toString() would, e.g., append a
    // trailing slash. The task-links service does its own normalization.
    return candidate;
  } catch {
    return null;
  }
}

/** Hostname of an already-validated http(s) URL, for the no-fetch fallback. */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/**
 * Build the TaskLinkInput[] for a single row from the configured
 * link_mappings. Empty cells are skipped (never error). Invalid tokens are
 * collected (for preview) but do not block the valid ones.
 *
 * Title rule honors the per-column `fetch_title` flag (plan §5.2):
 *   - static label given        → use it (title_source becomes 'user').
 *   - fetch_title === true       → leave title null, which lets createTask
 *                                  resolve internal suite titles inline and
 *                                  enqueue the async fetch for external URLs.
 *   - fetch_title falsy, no label → set the hostname as the title so NO async
 *                                  fetch is triggered — the user opted out.
 */
export function buildRowLinks(
  row: Record<string, string>,
  linkMappings: LinkMapping[] | undefined,
): { links: TaskLinkInput[]; invalid: { column: string; value: string }[] } {
  const links: TaskLinkInput[] = [];
  const invalid: { column: string; value: string }[] = [];
  if (!linkMappings) return { links, invalid };
  for (const lm of linkMappings) {
    const cell = row[lm.column]?.trim();
    if (!cell) continue;
    const { urls, invalid: bad } = parseLinkCell(cell);
    for (const url of urls) {
      let title: string | null;
      if (lm.label) {
        title = lm.label;
      } else if (lm.fetch_title) {
        title = null; // createTask resolves/queues a title
      } else {
        title = hostnameOf(url); // opted out of fetch → static hostname
      }
      links.push({ url, title });
    }
    for (const value of bad) {
      invalid.push({ column: lm.column, value });
    }
  }
  return { links, invalid };
}

// ═══════════════════════════════════════════════════════════════════════════
// DATE-LOCALE + CUSTOM-FIELD COERCION (Phase 2, §5.2 / §5.4.7) — Agent A section
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Coerce a raw date cell to an ISO date string (YYYY-MM-DD), deterministic per
 * the date_locale toggle.
 *
 *   - 'iso'  → unambiguous ISO formats win (YYYY-MM-DD, YYYY/MM/DD); numeric
 *              slash/dash dates are read as DD/MM/YYYY (unless a field > 12
 *              forces the other reading).
 *   - 'us'   → numeric slash/dash dates are MM/DD/YYYY.
 *
 * Returns the ISO string, or null when the value cannot be parsed (caller
 * raises a per-cell WARNING, never a row failure).
 */
export function coerceDate(raw: string, locale: DateLocale): string | null {
  const value = raw.trim();
  if (!value) return null;

  // Already ISO (YYYY-MM-DD or YYYY/MM/DD): take as-is.
  const isoMatch = value.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (isoMatch) {
    return toIso(Number(isoMatch[1]), Number(isoMatch[2]), Number(isoMatch[3]));
  }

  // Numeric slash/dash date with the year last (2- or 4-digit).
  const dmy = value.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
  if (dmy) {
    const a = Number(dmy[1]);
    const b = Number(dmy[2]);
    let year = Number(dmy[3]);
    if (year < 100) year += year < 70 ? 2000 : 1900;
    let month: number;
    let day: number;
    if (a > 12 && b <= 12) {
      // first field can't be a month → it's the day, regardless of locale
      day = a;
      month = b;
    } else if (b > 12 && a <= 12) {
      // second field can't be a month → it's the day
      month = a;
      day = b;
    } else if (locale === 'us') {
      month = a;
      day = b;
    } else {
      day = a;
      month = b;
    }
    return toIso(year, month, day);
  }

  // Word-y dates ("June 9, 2026", "9 Jun 2026") → Date.parse, then normalize.
  const parsed = Date.parse(value);
  if (!Number.isNaN(parsed)) {
    const d = new Date(parsed);
    return toIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }

  return null;
}

function toIso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${year}-${mm}-${dd}`;
}

const CHECKBOX_TRUTHY = new Set(['true', 'yes', 'x', '1', 'y', 't']);
const CHECKBOX_FALSY = new Set(['false', 'no', '0', 'n', 'f']);

/**
 * Result of coercing one cell to a custom-field type:
 *   - { ok: true, value }       → write `value` under the field. value ===
 *                                  undefined means the cell was empty → omit
 *                                  the key entirely (never store '').
 *   - { ok: false, reason }     → uncoercible → caller raises a per-cell WARNING
 *                                  and does NOT write the key.
 *
 * For select / multi_select, `appendedOptions` carries the option values seen so
 * the caller can append unseen ones to the definition.
 */
export type CoerceResult =
  | {
      ok: true;
      value: number | string | string[] | boolean | undefined;
      appendedOptions?: string[];
    }
  | { ok: false; reason: string };

export function coerceCustomFieldCell(
  raw: string,
  fieldType: CustomFieldType,
  locale: DateLocale,
): CoerceResult {
  const value = raw.trim();
  // Empty cell → key omitted entirely (never '').
  if (!value) return { ok: true, value: undefined };

  switch (fieldType) {
    case 'number': {
      // Strip $, thousands commas, % and whitespace, then parseFloat.
      const cleaned = value.replace(/[$,%\s]/g, '');
      const n = Number.parseFloat(cleaned);
      if (cleaned === '' || Number.isNaN(n)) {
        return { ok: false, reason: 'not a number' };
      }
      return { ok: true, value: n };
    }
    case 'date': {
      const iso = coerceDate(value, locale);
      if (!iso) return { ok: false, reason: 'unparseable date' };
      return { ok: true, value: iso };
    }
    case 'checkbox': {
      const lower = value.toLowerCase();
      if (CHECKBOX_TRUTHY.has(lower)) return { ok: true, value: true };
      if (CHECKBOX_FALSY.has(lower)) return { ok: true, value: false };
      return { ok: false, reason: 'not a boolean' };
    }
    case 'select': {
      return { ok: true, value, appendedOptions: [value] };
    }
    case 'multi_select': {
      // Split on comma OR semicolon: hand-typed cells use commas, but the CSV
      // export joins array values with "; " (export.routes formatCustomFieldForCsv),
      // so accepting ';' is what makes a multi_select column round-trip.
      const parts = value
        .split(/[;,]/)
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length === 0) return { ok: true, value: undefined };
      return { ok: true, value: parts, appendedOptions: parts };
    }
    case 'url': {
      const normalized = normalizeLinkToken(value);
      if (!normalized) return { ok: false, reason: 'not a URL' };
      return { ok: true, value: normalized };
    }
    default:
      return { ok: true, value };
  }
}

/**
 * A loaded custom-field definition relevant to the import (existing or
 * just-created), keyed by lower-cased name for idempotent lookup. `options` is
 * the live mutable option list for select/multi_select (so chunks compose).
 */
interface CustomFieldDef {
  id: string;
  name: string;
  field_type: CustomFieldType;
  options: string[];
}

/**
 * Find-or-create custom-field definitions for the configured mappings,
 * idempotently and race-tolerantly (matches the phase/label pattern). Returns a
 * Map keyed by the lower-cased field name. New definitions are positioned after
 * existing fields. When create_if_missing is false and no definition exists,
 * the column is omitted from the map (the caller silently skips it).
 */
async function resolveCustomFieldDefs(
  projectId: string,
  mappings: CustomFieldMapping[] | undefined,
): Promise<Map<string, CustomFieldDef>> {
  const byName = new Map<string, CustomFieldDef>();
  if (!mappings || mappings.length === 0) return byName;

  const existing = await db
    .select()
    .from(customFieldDefinitions)
    .where(eq(customFieldDefinitions.project_id, projectId))
    .orderBy(asc(customFieldDefinitions.position));

  for (const def of existing) {
    byName.set(def.name.trim().toLowerCase(), {
      id: def.id,
      name: def.name,
      field_type: def.field_type as CustomFieldType,
      options: Array.isArray(def.options) ? (def.options as string[]) : [],
    });
  }

  let nextPos = existing.reduce((max, d) => Math.max(max, d.position), 0) + 1;

  for (const mapping of mappings) {
    const key = mapping.field_name.trim().toLowerCase();
    if (byName.has(key)) continue;
    if (!mapping.create_if_missing) continue;

    const isOptioned = mapping.field_type === 'select' || mapping.field_type === 'multi_select';
    const [created] = await db
      .insert(customFieldDefinitions)
      .values({
        project_id: projectId,
        name: mapping.field_name.trim(),
        field_type: mapping.field_type,
        options: isOptioned ? [] : null,
        position: nextPos++,
      })
      .onConflictDoNothing()
      .returning();

    if (created) {
      byName.set(key, {
        id: created.id,
        name: created.name,
        field_type: created.field_type as CustomFieldType,
        options: Array.isArray(created.options) ? (created.options as string[]) : [],
      });
    } else {
      // Race: a concurrent chunk/process created it. Re-read.
      const [row] = await db
        .select()
        .from(customFieldDefinitions)
        .where(
          and(
            eq(customFieldDefinitions.project_id, projectId),
            eq(customFieldDefinitions.name, mapping.field_name.trim()),
          ),
        )
        .limit(1);
      if (row) {
        byName.set(key, {
          id: row.id,
          name: row.name,
          field_type: row.field_type as CustomFieldType,
          options: Array.isArray(row.options) ? (row.options as string[]) : [],
        });
      }
    }
  }

  return byName;
}

/**
 * Persist newly-appended select/multi_select options onto a definition.
 * Idempotent: unions against the live in-memory option list and writes only
 * when the set grew, so concurrent chunks compose without clobbering.
 */
async function flushAppendedOptions(def: CustomFieldDef, appended: Set<string>): Promise<void> {
  if (appended.size === 0) return;
  const merged = new Set(def.options);
  let grew = false;
  for (const opt of appended) {
    if (!merged.has(opt)) {
      merged.add(opt);
      grew = true;
    }
  }
  if (!grew) return;
  const nextOptions = [...merged];
  def.options = nextOptions;
  await db
    .update(customFieldDefinitions)
    .set({ options: nextOptions, updated_at: new Date() })
    .where(eq(customFieldDefinitions.id, def.id));
}

/**
 * Build the custom_fields object for one row from the configured mappings and
 * resolved definitions. Empty cells omit the key. Uncoercible cells push a
 * CellWarning (per row) and omit the key. select/multi_select appended options
 * are collected per-def in `pendingOptions` for a later flush.
 *
 * Side-effect-free aside from the warnings/pendingOptions accumulators — used by
 * BOTH the commit (writes) and preview (read-only) paths so they agree exactly.
 */
function buildRowCustomFields(
  row: Record<string, string>,
  rowNumber: number,
  mappings: CustomFieldMapping[] | undefined,
  defs: Map<string, CustomFieldDef>,
  locale: DateLocale,
  warnings: CellWarning[],
  pendingOptions: Map<string, Set<string>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!mappings) return out;
  for (const mapping of mappings) {
    const def = defs.get(mapping.field_name.trim().toLowerCase());
    if (!def) continue; // create_if_missing false + not existing → skip column
    const raw = row[mapping.column] ?? '';
    const result = coerceCustomFieldCell(raw, def.field_type, locale);
    if (!result.ok) {
      warnings.push({
        row: rowNumber,
        column: mapping.column,
        value: raw.trim(),
        reason: result.reason,
      });
      continue;
    }
    if (result.value === undefined) continue; // empty cell → omit key
    out[def.name] = result.value;
    if (result.appendedOptions && result.appendedOptions.length > 0) {
      let bucket = pendingOptions.get(def.id);
      if (!bucket) {
        bucket = new Set<string>();
        pendingOptions.set(def.id, bucket);
      }
      for (const opt of result.appendedOptions) bucket.add(opt);
    }
  }
  return out;
}

// ── duplicate detection (§5.2 / G8) ────────────────────────────────────────

/**
 * Load existing task titles for the project, lowercased+trimmed, as a set for
 * O(1) duplicate lookup. One batched query up front (not per-row).
 */
async function loadExistingTitleSet(projectId: string): Promise<Set<string>> {
  const rows = await db
    .select({ title: tasks.title })
    .from(tasks)
    .where(eq(tasks.project_id, projectId));
  const set = new Set<string>();
  for (const r of rows) {
    if (r.title) set.add(r.title.trim().toLowerCase());
  }
  return set;
}

// ═══════════════════════════════════════════════════════════════════════════
// UPDATE STRATEGY (Phase 3, §5.2 / §5.7 / §8) — Agent B owned section
// ═══════════════════════════════════════════════════════════════════════════
//
// duplicate_strategy:'update' round-trips a previously-exported sheet back into
// Bam. Matching, per §8 (leaning human_id over title since titles get edited):
//   - if mapping.human_id is present, MATCH the row's human_id cell against an
//     existing task's human_id within this project;
//   - else MATCH by exact title within the project (trim/case-insensitive).
// On match: overwrite mapped *non-empty* cells (empty cells leave the existing
// value untouched — the skip-empty rule); links MERGE (union by url, never
// clobber). Unmatched rows fall through to the normal create path.

/** One match index for the update strategy, built once per import. */
interface UpdateMatchIndex {
  byHumanId: Map<string, { id: string; human_id: string | null }>;
  byTitle: Map<string, { id: string; human_id: string | null }>;
}

/**
 * Load existing tasks of the project into lookup maps keyed by human_id (exact)
 * and by trimmed/lowercased title. Title collisions keep the first task seen so
 * the match is deterministic. One batched query up front (not per-row).
 */
async function loadUpdateMatchIndex(projectId: string): Promise<UpdateMatchIndex> {
  const rows = await db
    .select({ id: tasks.id, human_id: tasks.human_id, title: tasks.title })
    .from(tasks)
    .where(eq(tasks.project_id, projectId));
  const byHumanId = new Map<string, { id: string; human_id: string | null }>();
  const byTitle = new Map<string, { id: string; human_id: string | null }>();
  for (const r of rows) {
    const ref = { id: r.id, human_id: r.human_id };
    if (r.human_id) byHumanId.set(r.human_id.trim(), ref);
    if (r.title) {
      const key = r.title.trim().toLowerCase();
      if (!byTitle.has(key)) byTitle.set(key, ref);
    }
  }
  return { byHumanId, byTitle };
}

/**
 * Resolve which existing task (if any) a row matches under the update strategy.
 * Prefers human_id when mapping.human_id is configured AND the cell is
 * non-empty; otherwise (or on a human_id miss) falls back to exact title.
 * Returns null when nothing matches → the caller creates instead.
 */
function resolveUpdateMatch(
  row: Record<string, string>,
  mapping: Record<string, string>,
  title: string,
  index: UpdateMatchIndex,
): { id: string; human_id: string | null; matched_by: 'human_id' | 'title' } | null {
  const humanIdKey = mapping.human_id;
  if (humanIdKey) {
    const cell = row[humanIdKey]?.trim();
    if (cell) {
      const hit = index.byHumanId.get(cell);
      if (hit) return { ...hit, matched_by: 'human_id' };
    }
  }
  const hit = index.byTitle.get(title.toLowerCase());
  if (hit) return { ...hit, matched_by: 'title' };
  return null;
}

/**
 * Merge import links into the existing task's links as a UNION by url. Existing
 * entries win on url collision (their provenance — added_by/added_at/fetched
 * title — is preserved); new urls append. Returns null when there is nothing
 * to add (so the caller can omit `links` from the update and avoid a needless
 * re-resolve). Existing links are full TaskLink rows from the DB; incoming ones
 * are bare TaskLinkInput. updateTask re-normalizes the whole array, so passing
 * the existing rows back through is safe (their ids preserve provenance).
 */
function mergeLinksUnion(
  existing: TaskLink[],
  incoming: TaskLinkInput[],
): TaskLinkInput[] | null {
  if (incoming.length === 0) return null;
  const seen = new Set(existing.map((l) => l.url));
  const merged: TaskLinkInput[] = [...existing];
  let added = 0;
  for (const link of incoming) {
    if (seen.has(link.url)) continue;
    seen.add(link.url);
    merged.push(link);
    added++;
  }
  if (added === 0) return null;
  return merged;
}

/**
 * Load the stored links of a task for the union merge. Returns [] when the task
 * has none. Cast through TaskLink[] — the column is JSONB-on-task.
 */
async function loadTaskLinks(taskId: string): Promise<TaskLink[]> {
  const [row] = await db
    .select({ links: tasks.links })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  return ((row?.links as TaskLink[] | undefined) ?? []);
}

// ── commit (runImport) ─────────────────────────────────────────────────────

export async function runImport(
  projectId: string,
  body: ImportBody,
  reporterId: string,
): Promise<ImportResult & { updated?: number; cell_warnings?: CellWarning[] }> {
  const { rows, mapping, value_maps, link_mappings, custom_field_mapping, options } = body;
  const strategy: DuplicateStrategy = options?.duplicate_strategy ?? 'create';
  const dateLocale: DateLocale = options?.date_locale ?? 'iso';

  const titleKey = mapping.title;
  if (!titleKey) {
    throw new ImportError('mapping.title is required');
  }

  const defaultPhase = await getDefaultPhase(projectId);
  if (!defaultPhase) {
    throw new ImportError('Project has no phases configured');
  }

  const existingTitles =
    strategy === 'skip' ? await loadExistingTitleSet(projectId) : null;

  // Update strategy: build the match index once. Owned by Agent B.
  const updateIndex =
    strategy === 'update' ? await loadUpdateMatchIndex(projectId) : null;

  // Opt-in custom-field definitions (find-or-create, idempotent across chunks).
  const customFieldDefs = await resolveCustomFieldDefs(projectId, custom_field_mapping);
  // Appended select/multi_select options, collected per-def-id across rows then
  // flushed once at the end (so option growth is idempotent and chunk-safe).
  const pendingOptions = new Map<string, Set<string>>();
  const cellWarnings: CellWarning[] = [];

  let imported = 0;
  let skipped = 0;
  let updated = 0;
  const errors: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    try {
      const title = row[titleKey]?.trim();
      if (!title) {
        skipped++;
        errors.push(`Row ${i + 1}: missing title`);
        continue;
      }

      // Duplicate skip — exact title within project, case-insensitive.
      if (existingTitles?.has(title.toLowerCase())) {
        skipped++;
        continue;
      }

      // Update strategy: if this row matches an existing task, overwrite it in
      // place (skip-empty cells, link union) and move on. Unmatched rows fall
      // through to the create path below. Owned by Agent B.
      const updateMatch = updateIndex
        ? resolveUpdateMatch(row, mapping, title, updateIndex)
        : null;
      if (updateMatch) {
        await applyUpdateToTask(
          projectId,
          updateMatch.id,
          row,
          { mapping, value_maps, link_mappings },
          reporterId,
        );
        updated++;
        continue;
      }

      // Resolve phase (value-map aware).
      let phaseId = defaultPhase.id;
      if (mapping.phase_name) {
        const cell = row[mapping.phase_name]?.trim();
        if (cell) {
          const mapped = applyValueMap('phase_name', cell, value_maps);
          if (mapped.mapped) {
            // null → leave unset (use default phase); a value → find-or-create.
            if (mapped.value !== null) {
              const phase = await findOrCreatePhase(projectId, mapped.value);
              phaseId = phase.id;
            }
          } else {
            const phase = await findOrCreatePhase(projectId, cell);
            phaseId = phase.id;
          }
        }
      }

      // Resolve assignee.
      let assigneeId: string | null = null;
      if (mapping.assignee_email) {
        const cell = row[mapping.assignee_email]?.trim();
        if (cell) {
          const user = await findUserByEmail(cell);
          if (user) assigneeId = user.id;
        }
      }

      // Resolve labels.
      const labelIds: string[] = [];
      if (mapping.labels) {
        const cell = row[mapping.labels]?.trim();
        if (cell) {
          const labelNames = cell.split(',').map((l) => l.trim()).filter(Boolean);
          for (const name of labelNames) {
            const label = await findOrCreateLabel(projectId, name);
            labelIds.push(label.id);
          }
        }
      }

      // Resolve priority (value-map aware, then existing normalizer fallback).
      let priority: string | undefined;
      if (mapping.priority) {
        const cell = row[mapping.priority]?.trim();
        if (cell) {
          const mapped = applyValueMap('priority', cell, value_maps);
          if (mapped.mapped) {
            // null → leave unset (createTask applies the project default).
            priority = mapped.value ?? undefined;
          } else {
            priority = normalizePriority(cell);
          }
        }
      }

      // Description.
      let description: string | undefined;
      if (mapping.description) {
        const cell = row[mapping.description];
        if (cell?.trim()) description = cell;
      }

      // Story points.
      let storyPoints: number | null | undefined;
      if (mapping.story_points) {
        const cell = row[mapping.story_points]?.trim();
        if (cell) storyPoints = Number.parseInt(cell, 10) || null;
      }

      // Due date.
      let dueDate: string | null | undefined;
      if (mapping.due_date) {
        const cell = row[mapping.due_date]?.trim();
        if (cell) dueDate = cell;
      }

      // Links from link_mappings.
      const { links } = buildRowLinks(row, link_mappings);

      // Opt-in custom fields (coerced per the definition's type + date locale).
      const customFields = buildRowCustomFields(
        row,
        i + 1,
        custom_field_mapping,
        customFieldDefs,
        dateLocale,
        cellWarnings,
        pendingOptions,
      );

      const input: CreateTaskInput = {
        title,
        phase_id: phaseId,
        ...(description !== undefined ? { description } : {}),
        ...(assigneeId ? { assignee_id: assigneeId } : {}),
        ...(priority !== undefined ? { priority: priority as CreateTaskInput['priority'] } : {}),
        ...(storyPoints !== undefined ? { story_points: storyPoints } : {}),
        ...(dueDate !== undefined ? { due_date: dueDate } : {}),
        ...(labelIds.length > 0 ? { label_ids: labelIds } : {}),
        ...(links.length > 0 ? { links } : {}),
        ...(Object.keys(customFields).length > 0 ? { custom_fields: customFields } : {}),
      };

      await createTask(projectId, input, reporterId);

      // Keep the in-memory dup set coherent so a later row that duplicates an
      // earlier just-imported row is also skipped under 'skip'.
      if (existingTitles) existingTitles.add(title.toLowerCase());

      imported++;
    } catch (err) {
      skipped++;
      errors.push(`Row ${i + 1}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  // Flush appended select/multi_select options onto their definitions (once, at
  // the end — idempotent union write so chunks compose without duplication).
  for (const def of customFieldDefs.values()) {
    const appended = pendingOptions.get(def.id);
    if (appended) await flushAppendedOptions(def, appended);
  }

  // Surface per-cell coercion warnings in errors[] too (WARNING, not a failure:
  // the row still imported). cell_warnings carries the structured form.
  for (const w of cellWarnings) {
    errors.push(`Row ${w.row} [${w.column}]: ${w.reason} ("${w.value}")`);
  }

  // `updated` is only meaningful under the update strategy; omit it otherwise so
  // create/skip callers keep the original { imported, skipped, errors } shape.
  const base = strategy === 'update'
    ? { imported, skipped, updated, errors }
    : { imported, skipped, errors };
  return cellWarnings.length > 0 ? { ...base, cell_warnings: cellWarnings } : base;
}

// ═══════════════════════════════════════════════════════════════════════════
// applyUpdateToTask (Phase 3) — Agent B owned section
// ═══════════════════════════════════════════════════════════════════════════
//
// Build an UpdateTaskInput from a matched row and patch the existing task via
// task.service.updateTask. Only mapped, NON-EMPTY cells are written — empty
// cells are omitted entirely so the stored value is left untouched (skip-empty
// rule, §5.2). Links MERGE as a union by url (existing wins on collision); a
// row with no new links omits `links` so the stored array is untouched.
//
// Value-map and find-or-create semantics mirror the create path so a
// round-tripped sheet maps consistently in both directions.
async function applyUpdateToTask(
  projectId: string,
  taskId: string,
  row: Record<string, string>,
  cfg: {
    mapping: Record<string, string>;
    value_maps: ImportBody['value_maps'];
    link_mappings: LinkMapping[] | undefined;
  },
  actorId: string,
): Promise<void> {
  const { mapping, value_maps, link_mappings } = cfg;
  const patch: UpdateTaskInput = {};

  // Title — overwrite only when non-empty (the match may have been by human_id
  // with an edited title; an empty title cell must not blank the task).
  const titleCell = mapping.title ? row[mapping.title]?.trim() : undefined;
  if (titleCell) patch.title = titleCell;

  // Description.
  if (mapping.description) {
    const cell = row[mapping.description];
    if (cell?.trim()) patch.description = cell;
  }

  // Phase (value-map aware, find-or-create on passthrough).
  if (mapping.phase_name) {
    const cell = row[mapping.phase_name]?.trim();
    if (cell) {
      const mapped = applyValueMap('phase_name', cell, value_maps);
      if (mapped.mapped) {
        if (mapped.value !== null) {
          const phase = await findOrCreatePhase(projectId, mapped.value);
          patch.phase_id = phase.id;
        }
        // mapped to null → leave phase untouched (skip-empty semantics).
      } else {
        const phase = await findOrCreatePhase(projectId, cell);
        patch.phase_id = phase.id;
      }
    }
  }

  // Assignee — only set when the email resolves to a user.
  if (mapping.assignee_email) {
    const cell = row[mapping.assignee_email]?.trim();
    if (cell) {
      const user = await findUserByEmail(cell);
      if (user) patch.assignee_id = user.id;
    }
  }

  // Priority (value-map aware, normalizer fallback).
  if (mapping.priority) {
    const cell = row[mapping.priority]?.trim();
    if (cell) {
      const mapped = applyValueMap('priority', cell, value_maps);
      if (mapped.mapped) {
        if (mapped.value !== null) patch.priority = mapped.value as UpdateTaskInput['priority'];
        // mapped to null → leave priority untouched.
      } else {
        patch.priority = normalizePriority(cell) as UpdateTaskInput['priority'];
      }
    }
  }

  // Story points.
  if (mapping.story_points) {
    const cell = row[mapping.story_points]?.trim();
    if (cell) {
      const parsed = Number.parseInt(cell, 10);
      if (!Number.isNaN(parsed)) patch.story_points = parsed;
    }
  }

  // Due date.
  if (mapping.due_date) {
    const cell = row[mapping.due_date]?.trim();
    if (cell) patch.due_date = cell;
  }

  // Labels — overwrite (find-or-create) only when the cell is non-empty.
  if (mapping.labels) {
    const cell = row[mapping.labels]?.trim();
    if (cell) {
      const labelIds: string[] = [];
      for (const name of cell.split(',').map((l) => l.trim()).filter(Boolean)) {
        const label = await findOrCreateLabel(projectId, name);
        labelIds.push(label.id);
      }
      if (labelIds.length > 0) patch.label_ids = labelIds;
    }
  }

  // Links — UNION merge with the existing stored links (existing wins on url).
  const { links: incoming } = buildRowLinks(row, link_mappings);
  if (incoming.length > 0) {
    const existing = await loadTaskLinks(taskId);
    const merged = mergeLinksUnion(existing, incoming);
    if (merged) patch.links = merged;
  }

  // Nothing to write (all mapped cells were empty) → no-op, still counts as an
  // update match for reporting parity with preview.
  if (Object.keys(patch).length === 0) return;

  await updateTask(taskId, patch, actorId);
}

// ── preview (previewImport) — writes NOTHING ───────────────────────────────

export async function previewImport(
  projectId: string,
  body: ImportBody,
  _reporterId: string,
): Promise<PreviewResult> {
  const { rows, mapping, value_maps, link_mappings, custom_field_mapping, options } = body;
  const strategy: DuplicateStrategy = options?.duplicate_strategy ?? 'create';
  const dateLocale: DateLocale = options?.date_locale ?? 'iso';

  const titleKey = mapping.title;
  if (!titleKey) {
    throw new ImportError('mapping.title is required');
  }

  // Read-only context.
  const existingTitles = await loadExistingTitleSet(projectId);
  const existingPhaseNames = await loadExistingPhaseNames(projectId);
  const existingLabelNames = await loadExistingLabelNames(projectId);

  // Custom-field preview context: load existing defs (read-only) and synthesize
  // an in-memory def map for both existing-by-name and would-be-created columns,
  // so per-row coercion runs identically to the commit path WITHOUT writing.
  const previewDefs = await loadCustomFieldDefsForPreview(projectId);
  const customFieldDefs = new Map<string, CustomFieldDef>();
  // new_custom_fields tracks definitions a commit WOULD create (create_if_missing
  // + not already present), with inferred select/multi_select options.
  const newCustomFieldOrder: string[] = [];
  if (custom_field_mapping) {
    for (const cf of custom_field_mapping) {
      const key = cf.field_name.trim().toLowerCase();
      const existing = previewDefs.get(key);
      if (existing) {
        customFieldDefs.set(key, existing);
      } else if (cf.create_if_missing) {
        if (!customFieldDefs.has(key)) {
          customFieldDefs.set(key, {
            id: `preview:${key}`,
            name: cf.field_name.trim(),
            field_type: cf.field_type,
            options: [],
          });
          newCustomFieldOrder.push(key);
        }
      }
      // create_if_missing false + not existing → column ignored (no def added).
    }
  }
  // pendingOptions accumulates inferred select/multi_select options per def for
  // the new_custom_fields.inferred_options report (no DB write in preview).
  const previewPendingOptions = new Map<string, Set<string>>();

  const result: PreviewResult = {
    total_rows: rows.length,
    will_create: 0,
    will_skip: 0,
    // update-strategy counters (Phase 3, Agent B). Stay 0/[] under create/skip.
    will_update: 0,
    update_matches: [],
    new_phases: [],
    new_labels: [],
    new_custom_fields: [],
    unmapped_values: {},
    unresolved_assignees: [],
    invalid_urls: [],
    cell_warnings: [],
    duplicate_titles: [],
  };

  // Update strategy: load the match index once so each row can report whether it
  // resolves to an existing task (and how). Owned by Agent B.
  const updateIndex =
    strategy === 'update' ? await loadUpdateMatchIndex(projectId) : null;

  // Which fields are value-mapped (for unmapped_values reporting). A field is
  // tracked when either it has a value_map entry OR is a value-mappable target
  // present in the mapping (priority / phase_name). We always report distinct
  // passthrough values for priority and phase_name.
  const valueMappedFields = new Set<string>(['priority', 'phase_name']);
  for (const f of Object.keys(value_maps ?? {})) valueMappedFields.add(f);
  const unmapped: Record<string, Set<string>> = {};
  for (const f of valueMappedFields) {
    if (f === 'priority' || f === 'phase_name' ? mapping[f] : value_maps?.[f]) {
      unmapped[f] = new Set<string>();
    }
  }

  const newPhases = new Set<string>();
  const newLabels = new Set<string>();
  // De-dupe assignee lookups across rows.
  const assigneeCache = new Map<string, boolean>();
  // Track titles seen within the file (so duplicate detection covers
  // both DB collisions and in-file repeats).
  const seenTitles = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const rawTitle = row[titleKey]?.trim();
    if (!rawTitle) {
      // Mirrors runImport: missing title is a skip.
      result.will_skip++;
      continue;
    }
    const titleKeyLower = rawTitle.toLowerCase();

    // Duplicate detection (DB + in-file).
    const isDuplicate = existingTitles.has(titleKeyLower) || seenTitles.has(titleKeyLower);
    if (isDuplicate) {
      result.duplicate_titles.push({ row: i + 1, title: rawTitle });
    }
    seenTitles.add(titleKeyLower);

    if (isDuplicate && strategy === 'skip') {
      result.will_skip++;
    } else if (strategy === 'update' && updateIndex) {
      // Update strategy: a row that matches an existing task updates it;
      // otherwise it falls through to create (mirrors runImport). Owned by
      // Agent B. Match resolution uses the same helper as the commit path so
      // the dry-run count is contract-faithful (§5.3).
      const match = resolveUpdateMatch(row, mapping, rawTitle, updateIndex);
      if (match) {
        result.will_update++;
        result.update_matches.push({
          row: i + 1,
          human_id: match.human_id,
          matched_by: match.matched_by,
        });
      } else {
        result.will_create++;
      }
    } else {
      result.will_create++;
    }

    // Phase: track passthrough (new phase) values + unmapped reporting.
    if (mapping.phase_name) {
      const cell = row[mapping.phase_name]?.trim();
      if (cell) {
        const mapped = applyValueMap('phase_name', cell, value_maps);
        if (mapped.mapped) {
          if (mapped.value !== null && !existingPhaseNames.has(mapped.value.toLowerCase())) {
            newPhases.add(mapped.value);
          }
        } else {
          unmapped.phase_name?.add(cell);
          if (!existingPhaseNames.has(cell.toLowerCase())) newPhases.add(cell);
        }
      }
    }

    // Priority: track unmapped passthrough values.
    if (mapping.priority) {
      const cell = row[mapping.priority]?.trim();
      if (cell) {
        const mapped = applyValueMap('priority', cell, value_maps);
        if (!mapped.mapped) unmapped.priority?.add(cell);
      }
    }

    // Other custom value-mapped fields (mapped via a column of the same name).
    for (const field of Object.keys(value_maps ?? {})) {
      if (field === 'priority' || field === 'phase_name') continue;
      const col = mapping[field];
      if (!col) continue;
      const cell = row[col]?.trim();
      if (cell) {
        const mapped = applyValueMap(field, cell, value_maps);
        if (!mapped.mapped) unmapped[field]?.add(cell);
      }
    }

    // Labels: track new ones.
    if (mapping.labels) {
      const cell = row[mapping.labels]?.trim();
      if (cell) {
        for (const name of cell.split(',').map((l) => l.trim()).filter(Boolean)) {
          if (!existingLabelNames.has(name.toLowerCase())) newLabels.add(name);
        }
      }
    }

    // Assignee: unresolved emails.
    if (mapping.assignee_email) {
      const cell = row[mapping.assignee_email]?.trim();
      if (cell) {
        let resolved = assigneeCache.get(cell.toLowerCase());
        if (resolved === undefined) {
          const user = await findUserByEmail(cell);
          resolved = !!user;
          assigneeCache.set(cell.toLowerCase(), resolved);
        }
        if (!resolved) result.unresolved_assignees.push({ row: i + 1, value: cell });
      }
    }

    // Links: invalid URLs.
    const { invalid } = buildRowLinks(row, link_mappings);
    for (const bad of invalid) {
      result.invalid_urls.push({ row: i + 1, column: bad.column, value: bad.value });
    }

    // Custom fields: coerce (read-only) to collect cell warnings + inferred
    // select/multi_select options. Uses the same builder as commit so the
    // dry-run warnings match exactly.
    buildRowCustomFields(
      row,
      i + 1,
      custom_field_mapping,
      customFieldDefs,
      dateLocale,
      result.cell_warnings,
      previewPendingOptions,
    );
  }

  result.new_phases = [...newPhases];
  result.new_labels = [...newLabels];
  for (const [field, set] of Object.entries(unmapped)) {
    if (set.size > 0) result.unmapped_values[field] = [...set];
  }

  // new_custom_fields: report each would-be-created definition (in mapping
  // order), attaching inferred options for select/multi_select.
  for (const key of newCustomFieldOrder) {
    const def = customFieldDefs.get(key);
    if (!def) continue;
    const entry: { name: string; field_type: CustomFieldType; inferred_options?: string[] } = {
      name: def.name,
      field_type: def.field_type,
    };
    if (def.field_type === 'select' || def.field_type === 'multi_select') {
      const inferred = previewPendingOptions.get(def.id);
      entry.inferred_options = inferred ? [...inferred] : [];
    }
    result.new_custom_fields.push(entry);
  }

  return result;
}

// ── read-only loaders for preview ──────────────────────────────────────────

async function loadExistingPhaseNames(projectId: string): Promise<Set<string>> {
  const rows = await db
    .select({ name: phases.name })
    .from(phases)
    .where(eq(phases.project_id, projectId));
  const set = new Set<string>();
  for (const r of rows) if (r.name) set.add(r.name.trim().toLowerCase());
  return set;
}

async function loadExistingLabelNames(projectId: string): Promise<Set<string>> {
  const rows = await db
    .select({ name: labels.name })
    .from(labels)
    .where(eq(labels.project_id, projectId));
  const set = new Set<string>();
  for (const r of rows) if (r.name) set.add(r.name.trim().toLowerCase());
  return set;
}

/**
 * Load existing custom-field definitions keyed by lower-cased name. Read-only —
 * used by previewImport so the dry-run can match columns to existing fields and
 * report only the genuinely-new ones.
 */
async function loadCustomFieldDefsForPreview(
  projectId: string,
): Promise<Map<string, CustomFieldDef>> {
  const rows = await db
    .select()
    .from(customFieldDefinitions)
    .where(eq(customFieldDefinitions.project_id, projectId))
    .orderBy(asc(customFieldDefinitions.position));
  const byName = new Map<string, CustomFieldDef>();
  for (const def of rows) {
    byName.set(def.name.trim().toLowerCase(), {
      id: def.id,
      name: def.name,
      field_type: def.field_type as CustomFieldType,
      options: Array.isArray(def.options) ? (def.options as string[]) : [],
    });
  }
  return byName;
}

// ── errors ──────────────────────────────────────────────────────────────

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}
