---
name: frndo-import
description: Import a Frndo-style roadmap (feature CSV + user-stories markdown) into a Bam project as tasks with acceptance-criteria subtasks, drafting missing user stories interactively along the way. Use when the user wants to turn a roadmap-CSV/user-story document pair into Bam tasks via the bigbluebam MCP server.
---

# Frndo roadmap → Bam import (coordinator)

You are the coordinating agent for turning a roadmap file pair into Bam
tasks. You run in the MAIN conversation — you are the only layer that can
ask the user questions, so all go/no-go decisions, clarifications, and
ambiguity resolution happen HERE. Mechanical work is delegated:

- **bam-task-importer** (subagent): executes the MCP task creation from a
  structured spec you hand it. It never decides *what* to create.
- **frndo-story-writer** (subagent): drafts user stories in the house
  template for features that don't have one yet.

Read `reference.md` in this skill's directory before starting — it holds
the Frndo domain primer, the file-format spec, and the verified MCP tool
choreography (validated end-to-end 2026-06-12 against the local server).

## Arguments

`/frndo-import [csv-path] [stories-md-path] [project-name]`

Defaults when omitted: look in `docs/incoming/` for exactly one `*.csv`
and one user-stories `*.md`; if ambiguous, ask. If no project is named,
ask which Bam project to target (after listing what's available — see
Phase 0).

## Phase 0 — Resolve the target (before reading anything else)

1. `get_me` → note the active org.
2. `list_projects` → if the named project isn't in the active org,
   `list_my_orgs`, ask the user which org, `switch_active_org`, and list
   again. Never guess across orgs.
3. `bam_list_phases(project_id)` → default landing phase is the
   `is_start: true` phase (usually "Backlog"); confirm with the user only
   if there is no start phase.
4. Check for an epic to group under (`bam_list_epics`) — if the user
   mentioned one, resolve it; otherwise don't invent one.

## Phase 1 — Parse and join (yourself, no subagents)

Parse the CSV and the stories markdown per `reference.md` §File formats,
including the known data quirks (quoted multiline cells, multi-date
cells, trailing malformed rows with column drift, whitespace-padded
titles). Produce three buckets:

- **MATCHED**: CSV rows whose `User Stories` cell matches a story heading
  in the markdown (trimmed, case-insensitive; fall back to high-confidence
  fuzzy match and SAY SO in the preview when you used one).
- **UNMATCHED**: rows with an empty story cell, or a cell that merely
  repeats the feature text with no corresponding heading.
- **ORPHANS**: stories in the markdown no CSV row references (report
  them; import only if the user asks).

## Phase 2 — Preview and go/no-go (ask the user)

Show a compact preview: matched count (→ N tasks + ΣAC subtasks), the
title each task will get, the unmatched list, and any parse warnings.
Then ask (AskUserQuestion):
1. Proceed with the matched import?
2. Draft user stories for the unmatched features? (Which ones — they may
   want a subset.)

Never create anything before explicit confirmation.

## Phase 3 — Import matched features (delegate)

Build the spec per `reference.md` §Task spec:
- **Title**: `<Features cell, trimmed> - <Story title>` (≤500 chars).
- **Description**: `## Story` + `## Context` sections verbatim from the
  story, then a `---` provenance footer: source filenames, the CSV
  priority cell, and the CSV date text VERBATIM (dates like
  "Aug 31 (personality), Sep 30 (worldview)" don't fit a due-date field —
  the verbatim text is the truth).
- **Priority**: P0→critical, P1→high, P2→medium, P3→low, blank→none.
- **due_date**: only when the CSV date is a single unambiguous date
  (assume the roadmap year, currently 2026); otherwise null.
- **Subtasks**: one per Acceptance Criterion, in order. Title is the
  criterion text (checkbox markup stripped, whitespace collapsed); if a
  criterion exceeds ~300 chars, truncate the title at a word boundary
  with "…" and put the full text in the subtask description.

Spawn **bam-task-importer** with the spec (org/project/phase ids
resolved — never names) and relay its manifest: created human_ids,
idempotent skips, failures. If anything failed, surface it verbatim;
do not retry silently.

## Phase 4 — Draft missing stories (interactive, then delegate)

For the unmatched features the user opted into:
1. Triage each as CLEAR (enough signal in the feature text + Frndo primer
   to draft responsibly — e.g. "Push notifications") or UNCLEAR (one-word
   placeholders like "Diary.", "Frndo Coach.", "Usage cap").
2. For every UNCLEAR item, ask the user clarifying questions — batched at
   most 4 per AskUserQuestion call, one item per question, concrete
   options where you can infer plausible interpretations. Keep asking
   until each opted-in item is draftable or the user says skip it.
3. Spawn **frndo-story-writer** with: the feature rows, the user's
   clarifications, and 2 representative stories from the original
   markdown as style anchors. It writes
   `docs/incoming/<original-stem> - Addendum <YYYY-MM-DD>.md` in the
   combinable house format and returns the file path + story titles.
4. Show the user where the file landed and offer a quick review pause.

## Phase 5 — Import the new stories

After the user approves the drafted stories (or edits them), loop those
rows back through Phase 3 — same spec rules, same importer agent.

## Phase 6 — Report

End with the standard two blocks: a summary (counts, file written,
anything skipped/failed) and **How to see it in action** — the exact
board URL (`/b3/projects/<id>/board`), what the new cards look like
(parent badges on AC subtasks, List view tree), and one task to spot-check
against its source story.

## Hard rules

- This skill creates and updates tasks; it NEVER deletes anything, and it
  never edits the user's original source files (the addendum is a new file).
- Re-runs must be idempotent: the importer checks for an existing task
  with the same title before creating (skips + reports).
- Local sandbox first: if `get_server_info` shows anything other than the
  local/dev server, stop and confirm with the user before writing.
