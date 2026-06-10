# Bam Spreadsheet-Style CSV Import + Task Links — Plan (v2)

**Branch:** `feature-bam-csv-import` (off `main` @ df3f50f)
**Written:** 2026-06-10 · **Revised:** 2026-06-10 (v2 — explicit-mapping model,
per-column value translation, new task Links field)
**Status:** Plan — not yet implemented.

## 1. The ask

Production-management systems let you export a sheet from Excel/Google as CSV
and import it: row 1 carries column names, the first meaningful column (e.g.
column B "Feature" in the **Frndo Beta Release Google Sheet** — column A is
blank) identifies the task, and other columns populate task fields. Empty
cells are skipped, never errors.

v2 refinements from product direction:

1. **Explicit column→field mapping is the model.** Some sheet columns have no
   relationship to anything in Bam, and that is 100% fine — they stay
   unmapped and are ignored. One column maps to Title, one to Description,
   one to Priority, etc.
2. **Value translation per mapped column.** Example: Column C → Priority, but
   Column C contains `P0,P1,P2,P3,P4` while Bam's priorities are
   Critical/High/Medium/Low(/None). The user specifies a value map relative
   to that field (`P0→Critical, … P4→None`).
3. **New "Links" field on Bam tasks** (related, ships with this work): a
   list/array of URLs on a task — a Google Doc, a Brief doc, a Blueprint,
   a Board, anything — each optionally carrying a human-readable title,
   either user-assigned or pulled from the target page's own title. One or
   more CSV columns can map into this field.

## 2. What Bam already has (do not rebuild)

Survey of the existing import system (2026-06-10):

- `POST /projects/:id/import/csv` (`apps/api/src/routes/import.routes.ts:161`)
  takes pre-parsed `rows` (max 5000) + a client-built `mapping`
  (CSV header → target field). `title` is the only required mapping —
  **the explicit-mapping model the user wants is already the API's shape.**
- Mappable targets today: `title`, `description`, `phase_name`,
  `assignee_email` (email lookup), `labels` (comma-separated, auto-created),
  `priority` (normalized via a hardcoded Jira map), `story_points`,
  `due_date`. Unmapped columns are already simply ignored.
- Phases and labels are find-or-created (lines 16-61). Per-row error
  isolation with `{ imported, skipped, errors[] }` response.
- Frontend: `apps/frontend/src/components/import/import-dialog.tsx` — 4-step
  wizard (source → upload → preview + per-column mapping dropdowns with
  fuzzy auto-mapping, incl. a `__skip__` option → results). CSV parsing is a
  hand-rolled ~50-line parser.
- Custom fields exist (`custom_field_definitions` 7 types +
  `tasks.custom_fields` JSONB) but no import path writes them.
- `entity_links` (Wave 4) is a typed entity↔entity table
  (`src_type/src_id ↔ dst_type/dst_id`) — it models internal cross-app
  references, **not arbitrary external URLs**, so it complements rather than
  replaces the new Links field.

## 3. Gap analysis

| # | Gap | Notes |
|---|-----|-------|
| G1 | **No value translation.** Priority has one hardcoded Jira-ish map; phase/select values import verbatim (creating phases like "WIP" instead of mapping to "In Progress"). | Core of v2 ask. |
| G2 | **No Links field on tasks at all**, and therefore no way to map URL columns. | New schema + UI + import target. |
| G3 | No custom-field mapping targets (opt-in, per column). | Useful but **not** the default posture: default for an unmapped column is *ignore*, per product direction. |
| G4 | No server-side dry-run/preview of what an import will do. | Confidence for big sheets. |
| G5 | Hand-rolled CSV parser (no BOM/delimiter handling). | papaparse swap. |
| G6 | 5000-row single-request cap. | Chunked submission for massive sheets. |
| G7 | Leading blank columns require manual deletion. | Auto-ignore. |
| G8 | Re-import duplicates undefined. | `duplicate_strategy`. |

Empty-cell skipping already works for built-in fields and extends unchanged
to links and custom fields: empty cell ⇒ nothing set, never `""`.

## 4. Design — Part A: the task Links field

This is a standalone Bam feature the import then targets. It ships first.

### 4.1 Data model

- **Migration `0179_task_links.sql`** (idempotent, additive):
  `ALTER TABLE tasks ADD COLUMN IF NOT EXISTS links jsonb NOT NULL DEFAULT '[]';`
- **Shape** (Zod in `@bigbluebam/shared`, single source of truth):

```ts
const taskLinkSchema = z.object({
  id: z.string().uuid(),            // stable id for edit/remove in the UI
  url: z.string().url().max(2048),
  title: z.string().max(500).nullable(),   // null = "untitled / pending fetch"
  title_source: z.enum(['user', 'fetched', 'none']).default('none'),
  added_at: z.string().datetime(),
  added_by: z.string().uuid().nullable(),
});
// tasks.links: TaskLink[]  (cap: 50 links per task, enforced in service)
```

JSONB-on-task (like `custom_fields`) rather than a child table: links are
display/navigation data owned by one task, always loaded with it, never
queried independently. The cross-app graph use case is served separately
(§4.3).

### 4.2 API + UI

- `CreateTaskInput` / `UpdateTaskInput` gain optional `links` (Zod-validated,
  service enforces the 50 cap and de-dupes by URL).
- Task detail drawer (`apps/frontend/.../task-detail-drawer.tsx`): a "Links"
  section — list of `favicon/app-icon · title (or hostname) · open` rows,
  add-link input (URL + optional title), inline edit/remove. Suite-internal
  URLs (`/brief/…`, `/blueprint/…`, `/board/…`, `/b3/…`, etc.) render with
  the owning app's icon.
- Export-to-CSV gains a `links` column (`title <url>` entries, `;`-joined) so
  round-trips don't lose them.

### 4.3 Title resolution ("pull it from the title of the page")

Per-link, `title` resolves in priority order:

1. **User-assigned** (import column label or manual entry) → `title_source: 'user'`.
2. **Internal suite URL** → resolve synchronously at save time by parsing the
   path (`/brief/documents/:id` → Brief doc title, `/blueprint/d/:id` →
   diagram name, `/board/:id` → board name, `/b3/tasks/ref/:ref` → task
   title, …) via the owning app's table (shared DB) — cheap and reliable.
   Also **mirror into `entity_links`** (`bam.task ↔ brief.document`, kind
   `references`) so these links join the cross-app graph agents already use.
3. **External URL** → queued **worker job** (`task-link-title-fetch`) that
   GETs the page and extracts `<title>`/og:title, then patches the link.
   Async because synchronous fetches would stall imports of hundreds of
   rows. MUST reuse the SSRF guard + size/timeout discipline from the Wave-5
   outbound-webhook sender (no private IPs, 3s timeout, response cap, no
   redirects to private ranges). Note: Google Docs without public access
   will return a generic title or login page — fall back to hostname display
   when fetch fails; user can rename. Auth'd-fetch integrations are out of
   scope.

## 5. Design — Part B: import enhancements

### 5.1 Principles

- **Explicit mapping; unmapped = ignored.** The wizard's job is to make
  mapping fast (fuzzy auto-suggest), not to force everything across.
- **The wire format is fully resolved.** Value maps, link labels, custom
  field choices — all explicit in the request. Deterministic, scriptable
  from MCP later.
- **Spreadsheet forgiveness**: BOM, `;`/`\t` delimiters, blank lead columns
  ("delete col A" never needed), blank rows, `#N/A`, `$1,200`, `85%`.

### 5.2 Wire format (extends the existing endpoint, stays compatible)

```jsonc
POST /projects/:id/import/csv
{
  "rows": [ { "Feature": "...", "Prio": "P1", ... } ],
  "mapping": { "title": "Feature", "description": "Notes", "priority": "Prio",
               "phase_name": "Status", ... },                      // unchanged
  "value_maps": {                                                  // NEW (G1)
    // keyed by TARGET field; maps incoming cell value → Bam value
    "priority":   { "P0": "critical", "P1": "high", "P2": "medium",
                    "P3": "low", "P4": null },     // null = leave unset ("None")
    "phase_name": { "WIP": "In Progress", "Done": "Complete" }
  },
  "link_mappings": [                                               // NEW (G2)
    { "column": "Spec Doc",  "label": "Spec",  "fetch_title": false },
    { "column": "Design",    "label": null,    "fetch_title": true }
  ],
  "custom_field_mapping": [                                        // NEW (G3, opt-in)
    { "column": "Animation Complexity", "field_name": "Animation Complexity",
      "field_type": "select", "create_if_missing": true }
  ],
  "options": { "duplicate_strategy": "create" | "skip" | "update" } // NEW (G8)
}
```

**Value-map semantics** (applies to `priority`, `phase_name`, and `select` /
`multi_select` custom-field targets):

- Cell value found in the map → use the mapped value. Mapped to `null` →
  leave the field unset for that row (the "None" case; works because every
  consumer already treats missing as unset).
- Cell value NOT in the map → passthrough behavior per field: `phase_name`
  find-or-creates as today; `priority` falls back to the existing normalizer
  then to project default; `select` appends the option. The dry-run lists
  every unmapped distinct value so nothing passes through unseen.
- Matching is exact-after-trim, case-insensitive.

**Link-mapping semantics**: per row, per entry — skip empty cells; validate
URL-ish (prepend `https://` for bare domains); each non-empty cell appends
one link `{ url, title: label ?? null }`. `label` is a static per-column
title (e.g. every link from the "Spec Doc" column is titled "Spec");
`fetch_title: true` instead resolves titles per §4.3 (internal: inline,
external: queued). Multiple link columns simply append in column order. A
cell containing multiple URLs separated by whitespace/commas contributes one
link each.

### 5.3 Dry-run endpoint (G4)

`POST /projects/:id/import/csv/preview` — same body, writes nothing, returns
the report the confirm screen renders: rows to create/skip/update, phases &
labels & custom-field definitions that would be created, **distinct unmapped
values per value-mapped field**, unresolved assignee emails, invalid URLs,
cell coercion warnings, in-file duplicate titles. Dry-run numbers are
contract-tested to match what commit then does.

### 5.4 Frontend (import-dialog.tsx)

1. **papaparse swap** (worker mode, BOM/delimiter auto-detect) replacing the
   hand-rolled parser (G5).
2. **Normalization on load** (G7): drop columns with empty header AND empty
   cells (the Frndo col-A case), drop blank rows, trim + de-dupe headers.
3. **Mapping step** keeps the per-column dropdown; target list becomes:
   `Skip (default for unrecognized columns)` · built-in fields · `Links…` ·
   existing custom fields · `Create custom field…`. Fuzzy auto-suggest
   pre-fills obvious matches (leftmost non-empty column → Title; name /
   summary / feature headers; url/link/doc headers → Links).
4. **"Map values…" affordance** appears when a column is mapped to
   `priority`, `phase_name`, or a select-type custom field: a two-column
   table of *distinct incoming values* (scanned from the full column, with
   occurrence counts) → dropdown of valid target values + "leave unset" +
   "passthrough". Pre-seeded with smart guesses (P0/P1…, Highest/Lowest,
   exact matches). This table serializes to `value_maps`.
5. **Links mapping panel**: when a column is mapped to Links — optional
   static label input, or "fetch page titles" toggle; multiple columns can
   be mapped to Links simultaneously.
6. **Confirm screen** rendered from dry-run: "407 tasks · 2 phases created ·
   3 unmapped priority values (listed) · 12 links with titles to fetch ·
   3 assignees unresolved".
7. **Chunked submission with progress** for >5000-row files (G6);
   find-or-create paths are idempotent so chunks compose; downloadable
   error-report CSV on the results step.

### 5.5 Worked example — Frndo Beta Release sheet

`(blank) | Feature | Status | Owner | Prio | Notes | Spec Doc | Design | QA Cost | Internal Jokes`

- blank col A → auto-dropped. `Feature` → Title. `Status` → Phase with value
  map (`WIP→In Progress`). `Owner` → assignee email. `Prio` → Priority with
  value map (`P0→Critical … P4→leave unset`). `Notes` → Description.
- `Spec Doc` → Links (label "Spec"). `Design` → Links (fetch titles — a
  Brief/Board URL resolves its real title inline and mirrors to
  entity_links; a Google Doc URL gets a fetched or hostname title).
- `QA Cost` → user chooses: skip, or opt into a `number` custom field.
- `Internal Jokes` → stays unmapped. 100% ok.

### 5.6 Edge cases

Carried from v1: Excel/Sheets encodings and quoting (papaparse), date-locale
toggle, in-file duplicate titles, find-or-create race tolerance, permission
reuse (`bam.project_import_csv.create`; custom-field creation disclosed by
dry-run). New for v2: value-map keys with stray whitespace/case (normalize),
a value map left half-finished (dry-run lists leakage), link columns
containing non-URLs ("see Bob" → warning, cell skipped), link cap 50/task
(warn + truncate), SSRF discipline on title fetch (§4.3).

### 5.7 Service extraction + MCP

Extract row-processing from the route into
`apps/api/src/services/import.service.ts`; later register `bam_import_csv`
MCP tool (same body + `dry_run` flag). `update` strategy gates behind a
confirm_action token; `create`/`skip` don't.

## 6. Phasing

**Phase 0 — Links field** (independent value even without import):
migration 0179, shared Zod schema, create/update service support, task
drawer Links section, internal-URL title resolution + entity_links mirror,
worker title-fetch job with SSRF guards, export column. *~1–1.5 days.*

**Phase 1 — import core:** service extraction; `value_maps` (+ "Map values"
UI); `link_mappings` (+ Links panel); dry-run endpoint + confirm screen;
papaparse swap; blank column/row normalization; `duplicate_strategy:
create|skip`. *~2–3 days.*

**Phase 2 — scale + opt-in custom fields:** chunked submission + progress;
error-report download; `custom_field_mapping` with type inference offered
(never default); date-locale toggle. *~1–1.5 days.*

**Phase 3 — round-trip + agents:** `duplicate_strategy: update` (match on
exported `human_id` column when present, else exact title — leaning
human_id, see §8); lossless export (links + custom fields); `bam_import_csv`
MCP tool. *~1–1.5 days.*

## 7. Testing

- Unit: value-map resolution (hit / null / passthrough / case-trim); link
  cell parsing (multi-URL cells, bare domains, junk); link cap + URL dedupe;
  internal-URL title resolvers per app; coercion matrix for opt-in custom
  fields.
- API: dry-run ↔ commit parity; chunk idempotency; the three strategies;
  links land in `tasks.links` AND internal ones mirror to `entity_links`.
- Worker: title-fetch job — happy path, SSRF rejection (private IP, redirect
  to private), timeout fallback to hostname.
- E2E: Frndo-shaped fixture (blank col A, P0-P4 priorities, WIP statuses,
  one Brief URL + one external URL column, an unmapped junk column, empty
  cells, one bad email) → map + value-map + confirm → import → assert tasks,
  phase mapping, priorities, links (with resolved Brief title), unmapped
  column absent; re-import with `skip` → 0 created.
- Manual: same data exported from real Google Sheets AND real Excel.

## 8. Risks / open questions

- **External title fetch is best-effort**: private Google Docs yield login
  pages — fall back to hostname, let users rename. Authenticated fetch is
  explicitly out of scope.
- **Value-map leakage**: a half-finished map silently passthroughs — dry-run
  surfaces every unmapped distinct value; consider a "strict" toggle (unmapped
  value ⇒ skip cell) if passthrough proves surprising in practice.
- **Links vs attachments vs entity_links**: three link-ish surfaces now
  exist. Position: attachments = files, entity_links = typed internal graph
  (agent-facing), task.links = user-facing URL list (superset, mirrors into
  entity_links when internal). Document this in CLAUDE.md when shipping.
- **Open (product):** for `update` matching, prefer the exported `human_id`
  (FRND-123) over title? Leaning yes — titles get edited in sheets.
- **Open (product):** when a value-mapped phase target names a phase that
  doesn't exist ("In Progress" not yet in project), find-or-create it (lean
  yes — consistent with current behavior, and dry-run discloses it).
