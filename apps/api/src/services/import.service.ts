import { eq, and, sql, asc } from 'drizzle-orm';
import type { CreateTaskInput, TaskLinkInput } from '@bigbluebam/shared';
import { db } from '../db/index.js';
import { tasks } from '../db/schema/tasks.js';
import { phases } from '../db/schema/phases.js';
import { labels } from '../db/schema/labels.js';
import { users } from '../db/schema/users.js';
import { createTask } from './task.service.js';

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

export type DuplicateStrategy = 'create' | 'skip';

export interface LinkMapping {
  column: string;
  label?: string | null;
  fetch_title?: boolean;
}

export interface ImportBody {
  rows: Record<string, string>[];
  mapping: Record<string, string>;
  value_maps?: Record<string, Record<string, string | null>>;
  link_mappings?: LinkMapping[];
  options?: { duplicate_strategy?: DuplicateStrategy };
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export interface PreviewResult {
  total_rows: number;
  will_create: number;
  will_skip: number;
  new_phases: string[];
  new_labels: string[];
  unmapped_values: Record<string, string[]>;
  unresolved_assignees: { row: number; value: string }[];
  invalid_urls: { row: number; column: string; value: string }[];
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
 * Split a link cell into individual URLs (whitespace or comma separated),
 * prepend https:// to bare domains, and validate. Returns parsed URLs and the
 * raw tokens that failed validation (so preview can surface them).
 */
function parseLinkCell(cell: string): { urls: string[]; invalid: string[] } {
  const tokens = cell
    .split(/[\s,]+/)
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

// ── commit (runImport) ─────────────────────────────────────────────────────

export async function runImport(
  projectId: string,
  body: ImportBody,
  reporterId: string,
): Promise<ImportResult> {
  const { rows, mapping, value_maps, link_mappings, options } = body;
  const strategy: DuplicateStrategy = options?.duplicate_strategy ?? 'create';

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

  let imported = 0;
  let skipped = 0;
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

  return { imported, skipped, errors };
}

// ── preview (previewImport) — writes NOTHING ───────────────────────────────

export async function previewImport(
  projectId: string,
  body: ImportBody,
  _reporterId: string,
): Promise<PreviewResult> {
  const { rows, mapping, value_maps, link_mappings, options } = body;
  const strategy: DuplicateStrategy = options?.duplicate_strategy ?? 'create';

  const titleKey = mapping.title;
  if (!titleKey) {
    throw new ImportError('mapping.title is required');
  }

  // Read-only context.
  const existingTitles = await loadExistingTitleSet(projectId);
  const existingPhaseNames = await loadExistingPhaseNames(projectId);
  const existingLabelNames = await loadExistingLabelNames(projectId);

  const result: PreviewResult = {
    total_rows: rows.length,
    will_create: 0,
    will_skip: 0,
    new_phases: [],
    new_labels: [],
    unmapped_values: {},
    unresolved_assignees: [],
    invalid_urls: [],
    duplicate_titles: [],
  };

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
  }

  result.new_phases = [...newPhases];
  result.new_labels = [...newLabels];
  for (const [field, set] of Object.entries(unmapped)) {
    if (set.size > 0) result.unmapped_values[field] = [...set];
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

// ── errors ──────────────────────────────────────────────────────────────

export class ImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportError';
  }
}
