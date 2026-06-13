# frndo-import reference

Shared knowledge for the coordinator skill and its subagents. Verified
against the local BigBlueBam MCP server on 2026-06-12 (probe BBB-7/BBB-8,
created and deleted).

## Frndo domain primer

Frndo is an AI voice-companion iPhone app. Users are **Mates**; Frndo is
the companion herself ("she"). Stack: Unity avatar with an explicit state
machine (listening / generating / speaking), on-device STT, cloud TTS
with a Piper local fallback, streaming LLM inference. Product values:
Frndo should feel like a real friend — deep listening, honest reframing,
explicit relational memory across sessions — inside safety guardrails
(values-aligned conversation, dangerous-behavior flagging). The beta runs
roughly Jul–Oct 2026 on iPhone 13–17, with known workstreams around
latency/interruption, TTS pacing, thermal load, voice commerce
(products/food/events/travel), calendar memory, news hooks, diary,
coaching, and TestFlight QA. Roadmap dates without a year mean 2026.

## File formats

**Roadmap CSV** — header `Features,P,Date to be completed,User Stories`.
Quirks to handle:
- Quoted cells may contain commas and newlines — use a real CSV parse,
  not line splitting.
- `P` is P0–P3 (may be blank).
- Dates are free text: single ("Jul 15"), multi-phase
  ("Aug 31 (personality), Sep 30 (worldview)"), gated
  ("Sep 30 (gated: Figma specs due Jun 30)"), or blank.
- Trailing rows can be malformed (a missing cell drifts columns — if the
  "User Stories" cell looks like a markdown heading fragment or the row
  has fewer cells, flag it in the preview instead of trusting it).
- Titles may carry trailing spaces; trim before joining.

**User-stories markdown** — Google-Docs export. Each story is:

```
# **<Title>** {#anchor}
## Story {#...}
As a Mate, I want … so that …
## Context {#...}
…
## Acceptance Criteria {#...}
* \[ \] <criterion>
* \[ \] <criterion>
## Edge Cases and Considerations {#...}
## Out of Scope {#...}
## Notes {#...}
```

Split on `# **` headings (the first heading + table of contents block is
front matter — skip until the first real story). Strip the `{#…}` anchors
and the `\[ \]` escapes when extracting. Join key = the heading title,
trimmed, case-insensitive.

**Addendum file (story-writer output)** — same section structure, plain
ATX headings WITHOUT the `{#anchor}` cruft, one blank line between
sections, `* [ ]` checkboxes. Filename:
`<original stem> - Addendum <YYYY-MM-DD>.md`, next to the original. A
heading-level match means the two files can be concatenated and re-split
by the same parser.

## MCP tool choreography (validated)

Load schemas first via ToolSearch (`select:mcp__bigbluebam__<name>`).

| Step | Tool | Notes |
|------|------|-------|
| Identity / server | `get_me`, `get_server_info` | confirm org + sandbox before writing |
| Org switch | `list_my_orgs`, `switch_active_org` | projects are listed per ACTIVE org |
| Project + phase | `list_projects`, `bam_list_phases` | use the `is_start: true` phase id |
| Idempotency probe | `search_tasks` (`project_id` UUID, `q`) | skip when an exact-title task exists |
| Create parent | `create_task` | required: `project_id`, `title` (≤500), `phase_id` (name or UUID both work; pass UUIDs). Optional: `description` (markdown), `priority` enum `critical/high/medium/low/none`, `epic_id`, `label_ids` |
| Create subtask | `create_task` with `parent_task_id` (parent UUID) | parent's subtask counter updates server-side |
| Due date | `update_task` (`task_id`, `due_date` ISO) | `create_task` has NO due_date field |
| Epic: list | `bam_list_epics` (`project_id`) | the idempotency half — find an epic by name before creating |
| Epic: create | `bam_create_epic` (`project_id`, `name`, …) | create-if-absent; returns `{data:{id,…}}` |
| Epic: assign (new task) | `create_task` `epic_id` | set at creation for parent AND each subtask |
| Epic: assign (existing task) | `update_task` (`task_id`, `epic_id`) | retrofit path — `update_task` now accepts `epic_id` |

Gotchas:
- `create_task` returns `{data: {id, human_id, …}}` — capture `id` for
  subtasks, report `human_id` to the human.
- Don't parallelize creates blindly: create the parent, then its
  subtasks; different parents can proceed independently.
- Rate limits exist; on a 429 back off a few seconds and continue.
- NEVER call `delete_task` in this pipeline. Failed half-imports are
  reported, not rolled back.
- Epics are idempotent by NAME within a project: list once up front, build
  a `name → epic_id` map, create only the missing ones. Both the parent
  task and ALL its subtasks get the same `epic_id`.

## Task spec (coordinator → bam-task-importer)

```json
{
  "org_id": "uuid",
  "project_id": "uuid",
  "phase_id": "uuid",
  "epic_id": "uuid | null",
  "allow_near_duplicates": false,
  "tasks": [
    {
      "title": "Reduce Latency - Reduce Inter-Sentence Latency Perception and Enable Reliable Interruption",
      "description": "## Story\n…\n\n## Context\n…\n\n---\n_Imported from `Frndo Beta release - Sheet3.csv` + `FRNDO User Stories.md` · CSV priority: P0 · CSV date: \"Jul 15\"_",
      "priority": "critical",
      "due_date": "2026-07-15",
      "epic_name": "Reduce Latency",
      "subtasks": [
        { "title": "<criterion>", "description": null }
      ]
    }
  ]
}
```

`epic_name` (optional, per task): the verbatim CSV **Features** cell. When
present, the importer ensures an epic with that exact name exists in the
project (idempotent by name) and assigns BOTH the parent task and every
subtask to it. Omit it (or leave null) to skip epic assignment. The
spec-level `epic_id` is a different thing — a single pre-resolved epic for
the whole batch; `epic_name` is per-task and resolved by the importer.
