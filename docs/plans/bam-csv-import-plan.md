# Bam Spreadsheet-Style CSV Import — Plan

**Branch:** `feature-bam-csv-import` (off `main` @ df3f50f)
**Written:** 2026-06-10
**Status:** Plan — not yet implemented.

## 1. The ask

Production-management systems (ftrack, ShotGrid, etc.) let you export a sheet
from Excel/Google as CSV and import it wholesale: row 1 carries the column
names, column 1 (after any blank lead-in columns) identifies the entity (the
task — in prod-mgmt terms the asset/shot/feature), and every other column's
data lands under the matching field. Empty cells are skipped, not errors. The
concrete motivating case: the **Frndo Beta Release Google Sheet**, where
column B holds the Feature names and the columns to its right hold per-feature
data — the user wants to save that as CSV and have it appear in Bam without
hand-copying, even for very large sheets.

## 2. What Bam already has (do not rebuild)

The survey of the existing import system (2026-06-10) found more than CLAUDE.md
implies. **The skeleton of this feature already exists**:

- `POST /projects/:id/import/csv` (`apps/api/src/routes/import.routes.ts:161`)
  takes pre-parsed `rows` (max 5000) + a client-built `mapping`
  (CSV header → target field). `title` is the only required mapping.
- Mappable target fields today: `title`, `description`, `phase_name`,
  `assignee_email` (email lookup only), `labels` (comma-separated,
  auto-created), `priority`, `story_points`, `due_date`.
- Phases and labels are **find-or-created** on the fly (lines 16-61).
- Per-row error isolation: a bad row increments `skipped` with a
  `"Row N: <error>"` message; the rest import. Response:
  `{ imported, skipped, errors[] }`.
- Frontend: `apps/frontend/src/components/import/import-dialog.tsx` — a
  4-step wizard (source → upload → **preview + per-column mapping dropdowns**
  with fuzzy auto-mapping → results). CSV parsing is a ~50-line hand-rolled
  parser in the same file.
- Custom fields infrastructure exists and is healthy:
  `custom_field_definitions` per project (`text | number | date | select |
  multi_select | checkbox | url`) + `tasks.custom_fields` JSONB. The Wave-4
  `task-upsert.service.ts` already writes custom fields — **but no import
  path does.**

## 3. Gap analysis — what's actually missing

| # | Gap | Why it blocks the ask |
|---|-----|----------------------|
| G1 | Unmapped columns are **dropped** | The whole point of the sheet-import workflow is "everything in the sheet comes over." Today only the ~8 built-in fields survive; the Frndo sheet's other columns would vanish silently. |
| G2 | No custom-field targets in the mapping | Even manually, there is no way to direct a column into `tasks.custom_fields`. |
| G3 | No type inference | A column of `12, 7, 30` should become a `number` custom field; `2026-06-12` a `date`; `TRUE/FALSE` a `checkbox`; a low-cardinality text column a `select`. |
| G4 | No server-side dry-run | The client preview shows raw cells but can't tell you "3 assignee emails won't resolve, 2 phases will be created, 5 new custom fields will be defined" before committing. |
| G5 | Hand-rolled CSV parser | No BOM handling, no `;`/`\t` delimiter detection, untested against Excel's quoting quirks. Fine for small files, risky for "massive" ones. |
| G6 | 5000-row cap, single request | "Even a massive one" needs chunked submission with progress, not a hard wall. |
| G7 | Leading blank columns ("we'd probably need to delete col A") | Should be auto-ignored, not a manual pre-processing step. |
| G8 | Re-import / duplicate behavior undefined | Importing the same sheet twice creates duplicate tasks. |

Empty-cell skipping (the user's explicit requirement) **already works** for
built-in fields (`?.trim()` guards throughout) — the plan just extends the
same rule to custom fields: empty cell ⇒ key omitted from the JSONB, never
written as `""`.

## 4. Design

### 4.1 Principles

- **Extend, don't fork.** Same endpoint, same dialog, same mapping concept.
  The new capability is a new kind of mapping target, not a new pipeline.
- **The mapping stays explicit on the wire.** Auto-behavior (fuzzy matching,
  type inference) lives in the UI and in a dry-run response; what the import
  endpoint receives is always a fully-resolved declaration of intent. That
  keeps the API deterministic and the MCP/agent path scriptable.
- **Spreadsheet forgiveness.** BOMs, blank lead columns, blank rows, duplicate
  headers, `#N/A`, currency/percent formatting — handle the things Excel and
  Google Sheets actually emit.

### 4.2 API changes (`apps/api`)

**A. Extend the mapping schema** on `POST /projects/:id/import/csv`:

```jsonc
{
  "rows": [...],
  "mapping": { "title": "Feature", "phase_name": "Status", ... },   // unchanged
  "custom_field_mapping": [                                          // NEW
    {
      "column": "Animation Complexity",       // CSV header
      "field_name": "Animation Complexity",   // custom_field_definitions.name
      "field_type": "select",                 // one of the 7 supported types
      "create_if_missing": true               // define the field if absent
    }
  ],
  "options": {                                                       // NEW
    "duplicate_strategy": "create" | "skip" | "update"  // default "create"; matching key = exact title within project
  }
}
```

Per row, for each custom-field mapping: skip empty cells; coerce the cell to
the field type (`number` → parseFloat after stripping `$ % ,`; `date` → ISO
date; `checkbox` → TRUE/yes/x/1; `multi_select` → comma-split; `select` /
`multi_select` values get appended to the definition's `options` when new);
uncoercible cells become a per-row warning (`"Row N, 'Budget': 'TBD' is not a
number — cell skipped"`) **without failing the row**. Definitions are
find-or-created with the same idempotent pattern as phases/labels, positioned
after existing fields.

**B. New dry-run endpoint** `POST /projects/:id/import/csv/preview` — same
body, **writes nothing**, returns the resolution report the confirm screen
renders:

```jsonc
{
  "total_rows": 412,
  "will_create": 407, "will_skip": 3, "will_update": 2,
  "new_phases": ["In Review"],
  "new_labels": ["beta"],
  "new_custom_fields": [{ "name": "Animation Complexity", "field_type": "select", "inferred_options": ["Low","Med","High"] }],
  "unresolved_assignees": [{ "row": 12, "value": "jane@oldco.com" }],
  "cell_warnings": [{ "row": 31, "column": "Budget", "value": "TBD", "reason": "not_a_number" }],
  "duplicate_titles": [{ "row": 88, "title": "Login flow", "existing_task": "FRND-123" }]
}
```

**C. Chunking + dedup of side effects.** Keep the 5000-row per-request cap
(it bounds request size sanely) but make the endpoint chunk-safe: the client
sends `chunk_index`/`chunk_count` and the endpoint's find-or-create paths are
already idempotent, so phases/labels/field definitions created by chunk 1 are
simply found by chunk 2. `position` allocation per chunk continues from max.

**D. `duplicate_strategy: "update"`** (stretch, see phasing): match by exact
title within the project; non-empty mapped cells overwrite, empty cells leave
the existing value alone (mirrors the skip-empty rule and enables round-trip
with the existing CSV export, which emits titles). `skip` is cheap and ships
with phase 1; `update` needs the activity-log/broadcast side effects of the
task-update service and ships later.

**No migration is needed.** `custom_field_definitions` + `tasks.custom_fields`
already model everything; this is pure route/service/UI work.

### 4.3 Frontend changes (`apps/frontend`, import-dialog.tsx)

1. **Parser swap:** replace the hand-rolled parser with **papaparse**
   (worker-mode streaming, BOM stripping, delimiter auto-detect, RFC-4180
   quoting). It's the standard answer to G5/G6 and removes ~50 lines of
   bespoke code.
2. **Sheet normalization on load (G7):** drop columns whose header AND all
   cells are empty (the Frndo "col A" case — no manual deletion needed); drop
   fully-empty rows; trim headers; de-duplicate repeated headers as
   `Name (2)`.
3. **Mapping step becomes three-bucket:** for each CSV column the dropdown
   offers (a) built-in fields (unchanged), (b) **existing custom fields** of
   the project, (c) **"Create custom field…"** pre-filled with the inferred
   type from sampling up to 200 cells (all-numeric → number, all-date →
   date, TRUE/FALSE-ish → checkbox, ≤12 distinct values with repetition →
   select, comma-separated low-cardinality → multi_select, else text — with
   a type dropdown to override). Default behavior matches the user's mental
   model: **every non-empty column maps to *something*** — exact-name match
   to a built-in or existing custom field first, otherwise "create custom
   field" preselected. `__skip__` remains available per column.
4. **First-column heuristic:** preselect the leftmost non-empty column as
   `title` (after fuzzy matching for explicit name/title/summary/feature
   headers).
5. **New confirm screen** between mapping and import, rendered from the
   dry-run response: "407 tasks will be created · 1 new phase · 5 new custom
   fields · 3 assignees won't resolve (left unassigned) · 14 cells skipped."
   This is where trust in "import my massive sheet" is won.
6. **Chunked submission with progress bar** for >5000-row files; per-chunk
   results accumulate into the existing results step.
7. **Results step:** add a downloadable error report (CSV of failed/warned
   rows) so a user can fix and re-import just the stragglers.

### 4.4 Worked example — Frndo Beta Release sheet

Header row: `(blank) | Feature | Status | Owner | Priority | Notes |
Animation Complexity | Est. Days | Ship? | …`

- Blank col A → auto-dropped (G7).
- `Feature` → `title` (leftmost non-empty + fuzzy match).
- `Status` → `phase_name` (phases auto-created: "In Review" etc.).
- `Owner` → `assignee_email` if cells look like emails; otherwise the dry-run
  flags it and the user maps it to a text custom field instead. (Name→user
  resolution is intentionally out of scope v1 — ambiguous and surprise-prone.)
- `Priority` → built-in `priority` (existing Jira-style normalization).
- `Notes` → `description`.
- `Animation Complexity` → new `select` custom field, options harvested from
  the data.
- `Est. Days` → new `number` custom field.
- `Ship?` → new `checkbox` custom field.
- Empty cells anywhere → that field simply isn't set on that task.

### 4.5 Edge cases to handle explicitly

- UTF-8 BOM from Excel; `;` delimiter from EU-locale Excel; `\t` from
  copy-paste TSV (papaparse covers all three).
- Quoted cells containing newlines and commas (papaparse).
- Excel artifacts in cells: `#N/A`, `#REF!`, `'`-prefixed text, `$1,200`,
  `85%` — strip/normalize for typed fields, keep verbatim for text.
- Date ambiguity: accept ISO + unambiguous formats; ambiguous `MM/DD vs
  DD/MM` resolved by a locale toggle on the mapping step defaulting to
  US-style, with the dry-run echoing parsed dates for eyeballing.
- Duplicate titles **within the file**: warn in dry-run; both import under
  `create` (legit in prod-mgmt), collapse under `skip`/`update`.
- 7 existing custom-field types only — no new types in v1.
- Concurrency: two simultaneous imports to one project — find-or-create
  helpers already tolerate races for phases/labels; replicate the same
  on-conflict pattern for field definitions.
- Permissions: reuse `bam.project_import_csv.create` + `read_write` scope;
  custom-field definition creation during import must also satisfy the
  custom-field capability or be explicitly granted by the import capability
  (decide during implementation; lean: import capability implies it, since
  the dry-run discloses exactly what will be created).

### 4.6 MCP / agent surface (cheap win, rides on the same service)

Extract the import core out of the route file into
`apps/api/src/services/import.service.ts` (route currently inlines ~100 lines
of row-processing). Then register an MCP tool `bam_import_csv` (rows +
mapping + custom_field_mapping + dry_run flag) so agents can do sheet→Bam
without the UI. The destructive-action bar is low (creates, doesn't delete),
so no confirm_action token needed for `create`; `update` strategy should gate
behind one.

## 5. Phasing

**Phase 1 — core (the ask):** service extraction; `custom_field_mapping` +
find-or-create definitions + typed coercion + skip-empty; dry-run endpoint;
frontend three-bucket mapping with inference + confirm screen; papaparse
swap; blank column/row normalization; `duplicate_strategy: skip|create`.
*Estimate: 2–3 days.*

**Phase 2 — scale + polish:** chunked submission with progress; downloadable
error report; locale toggle for dates; per-column "sample parse" hints in the
mapping UI. *Estimate: 1 day.*

**Phase 3 — round-trip + agents:** `duplicate_strategy: update` (export →
edit in Sheets → re-import); export gains custom-field columns so the
round-trip is lossless; `bam_import_csv` MCP tool. *Estimate: 1–1.5 days.*

## 6. Testing

- Unit: coercion matrix per field type (incl. `$1,200`, `85%`, `TRUE`, `#N/A`,
  empty); inference sampler; duplicate-header/blank-column normalization.
- API: dry-run vs commit parity (dry-run numbers must match what commit then
  does); chunk idempotency (same definitions not duplicated across chunks);
  partial-failure tallies; the 3 strategies.
- E2E (Playwright, `apps/e2e`): upload a fixture modeled on the Frndo sheet
  (blank col A, mixed types, empty cells, 1 bad email) → confirm screen
  numbers → import → assert tasks, phases, custom-field definitions, and
  JSONB values; re-import with `skip` → 0 created.
- Manual: a real Google Sheets export and a real Excel export of the same
  data (they differ: BOM, quoting, date serialization).

## 7. Risks / open questions

- **Custom-field sprawl:** a 40-column sheet creates 35 custom fields and the
  task drawer becomes soup. Mitigation: confirm screen lists every new field
  with a checkbox (default on), and `is_visible_on_card` defaults to false
  for imported fields. Not solved here: field lifecycle/cleanup UI.
- **Select-option growth on re-import:** appending unseen options is correct
  but can accumulate typos ("Med", "Medium"). Dry-run surfaces new options so
  the user can fix the sheet first. Accepted for v1.
- **Name-based assignee matching** is deliberately punted; revisit only with
  an explicit disambiguation UI.
- **Open question for product:** should `update` match on the exported
  `human_id` (FRND-123) column when present, instead of title? (Safer; titles
  get edited.) Leaning yes — decide before Phase 3.
