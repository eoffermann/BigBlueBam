# BigBlueBam Documentation

**BigBlueBam** is a web-based, multi-user Kanban project planning tool with sprint-based task management. It supports multiple concurrent projects with fully configurable phases, task states, custom fields, and carry-forward mechanics. Designed for small-to-medium teams (2–50 users).

This directory holds all written documentation for the project. Files are grouped by *what activity they support*, not by topic — so the same app may have content in `guides/`, `reference/`, `apps/<name>/`, and `history/` simultaneously.

---

## Top-level Layout

| Folder | What lives here |
|---|---|
| [`guides/`](./guides/) | **How-to docs.** Read these to get something done — setup, deploy, operate, develop. |
| [`reference/`](./reference/) | **What-is docs.** Stable specs that describe the system as it is — architecture, schema, API, permissions, MCP catalog, design documents. |
| [`apps/`](./apps/) | **Per-app docs.** One folder per app (bam, banter, beacon, …) with guide / marketing / mcp-tools / narrative. Generated from the in-app help system. |
| [`plans/`](./plans/) | **Active plans.** In-flight work that is not yet shipped: feature plans, design strategies, backlog trackers. Once shipped, content moves to `history/completed-plans/`. |
| [`history/`](./history/) | **Frozen records.** Point-in-time snapshots of audits, recovery runs, postmortems, and shipped plans. Read for context; do not edit. |
| [`design-audits/`](./design-audits/) | Periodic design audits, dated. |
| [`functionality-audits/`](./functionality-audits/) | Periodic functionality audits, dated. |
| [`security-audits/`](./security-audits/) | Periodic security audits, dated. |
| [`user-testing/`](./user-testing/) | User-testing investigations and issue logs, dated. |
| [`notes/`](./notes/) | Loose notes that don't fit elsewhere — open-work trackers, scratch references, build-pipeline logs. |
| [`auto/`](./auto/) | Build artifacts from `pnpm docs:generate` (changed-apps manifest, screenshot manifest). Not human-edited. |

---

## Getting Started

If you're new to the repo, read in this order:

1. [`guides/getting-started.md`](./guides/getting-started.md) — prerequisites, first run, troubleshooting
2. [`guides/deployment.md`](./guides/deployment.md) — quickstart wizard + tier progression
3. [`reference/architecture.md`](./reference/architecture.md) — how the 22 services fit together
4. [`reference/BigBlueBam_Design_Document.md`](./reference/BigBlueBam_Design_Document.md) — the canonical v1 design spec (with [`_v1_Addendum.md`](./reference/BigBlueBam_Design_Document_v1_Addendum.md) for post-v1 additions)

---

## Reference (evergreen specs)

| Document | Description |
|---|---|
| [Architecture](./reference/architecture.md) | System design, tech stack, data flow, container layout, client architecture |
| [API Reference](./reference/api-reference.md) | REST endpoints, authentication, pagination, filtering, error codes |
| [Database](./reference/database.md) | Entity-relationship diagrams, table reference, indexing, migrations, RLS, partitioning |
| [Permissions](./reference/permissions.md) | Permission model, role hierarchy, org/project/guest scoping, enforcement surfaces |
| [MCP Server](./reference/mcp-server.md) | 340 tools across 43 modules, architecture, tool registry |
| [Agent Conventions](./reference/agent-conventions.md) | Rules agents must follow: visibility preflight, entity-type allowlist, audit |
| [BigBlueBam Design Document](./reference/BigBlueBam_Design_Document.md) | Canonical v1 design spec |
| [Design Document — v1 Addendum](./reference/BigBlueBam_Design_Document_v1_Addendum.md) | Post-v1 feature additions |

## Guides (how-to)

| Document | Description |
|---|---|
| [Getting Started](./guides/getting-started.md) | Prerequisites, installation, quick start with Docker, development mode |
| [Development](./guides/development.md) | Developer guide, monorepo workflow, testing, code style, contributing |
| [Deployment](./guides/deployment.md) | Quickstart wizard, deployment tiers (T1–T4), Docker Compose + Railway, backup/DR, monitoring, CI/CD |
| [Operations](./guides/operations.md) | Updating, backups, maintenance tasks |
| [Railway Runbook](./guides/railway-runbook.md) | Operator runbook for the Railway platform deployment |
| [Local SSL Notes](./guides/local-ssl-notes.md) | TLS options for local/LAN deploys: self-signed, mkcert, Let's Encrypt |
| [Seeding Smoke Test](./guides/seeding-smoke-test.md) | 14-URL click-through checklist verifying demo seed data |

## Per-app docs

Each app under [`apps/`](./apps/) has the same five-file layout:

- `guide.md` — user-facing how-to
- `marketing.md` — product overview
- `mcp-tools.md` — MCP tool reference for that app
- `_narrative.md` — voice/positioning copy (input to the docs-generation pipeline)
- `_marketing_hook.md` — short marketing hook

Apps: bam, banter, beacon, bearing, bench, bill, blank, blast, board, bolt, bond, book, brief, helpdesk.

## Active plans

| Plan | Description |
|---|---|
| [Permissions Overhaul Plan](./plans/permissions-overhaul-plan.md) | Per-action permissions migration (multi-wave) |
| [Autodocumentation Pipeline Plan](./plans/autodocumentation-pipeline-plan.md) | Spec for the zero-touch docs regeneration pipeline |
| [Bolt Advanced UI Strategy](./plans/bolt-advanced-ui-strategy.md) | Design exploration for the Bolt rule builder |
| [Bolt ID-Mapping Strategy](./plans/bolt-id-mapping-strategy.md) | Strategy doc for Bolt's 322-tool ID-mapping surface |
| [Beacon Development Plan](./plans/beacon-development-plan.md) | Backend/frontend phases for Beacon |
| [Board Development Plan](./plans/board-development-plan.md) | Build breakdown for Board (Yjs + tldraw + LiveKit) |
| [Banter UI Alignment Plan](./plans/banter-ui-alignment-plan.md) | Unify Banter & Bam UI chrome |
| [Remaining Work (post-Wave 4)](./plans/remaining-work-2026-04-16.md) | Open work backlog after the 2026-04-14 recovery run |
| [Agentic TODO](./plans/agentic-todo.md) | MCP capability-vs-tool gap analysis |

## History (frozen records)

| Item | What it documents |
|---|---|
| [`history/early-design-documents/`](./history/early-design-documents/) | Original per-app design docs from project inception |
| [`history/completed-plans/`](./history/completed-plans/) | Plans that shipped (user-management, beacon-frontend fixes, MCP gap closure) |
| [`history/permissions-wave-d-audit/`](./history/permissions-wave-d-audit/) | Wave D permissions overhaul: synthesis, phase reports, role-default proposal |
| [`history/2026-04-13-rolled-back/`](./history/2026-04-13-rolled-back/) | Decisions + migration ledger from the rolled-back April 13 attempt |
| [`history/2026-04-14-recovery/`](./history/2026-04-14-recovery/) | Recovery-run decisions, postmortem, progress log, implementation plan, 15 per-app plans |
| [`history/2026-04-15-seeding/`](./history/2026-04-15-seeding/) | Seeding recovery plan (gap analysis + Acme scenario) |
| [`history/helpdesk-bbb-communication-audit.md`](./history/helpdesk-bbb-communication-audit.md) | Cross-cutting audit of helpdesk ↔ bbb interop (57 issues) |
| [`history/permissions-pipeline-audit-findings.md`](./history/permissions-pipeline-audit-findings.md) | Permissions pipeline audit (82 issues, pre-Wave D) |

## Audit batches

- [`design-audits/`](./design-audits/) — 2026-04-09 (per-app + platform) and 2026-04-14 (per-app + platform)
- [`functionality-audits/`](./functionality-audits/) — 2026-04-09
- [`security-audits/`](./security-audits/) — 2026-04-05 (beacon), 2026-04-07 (bolt, bearing, brief), 2026-04-09 (full suite)
- [`user-testing/`](./user-testing/) — 2026-04-09 (issues + investigations per app)

## Notes

| Document | Description |
|---|---|
| [Future Work](./notes/future-work.md) | What's unfinished on main (small items, not full plans) |
| [Board Collaboration Notes](./notes/board-collaboration-notes.md) | Working notes for Board real-time collaboration |
| [Docs Generation Log](./notes/docs-generation-log.md) | Append-only log of `pnpm docs:generate` runs |

---

## How this hierarchy was chosen

Files are placed by **the activity they support**, not just by topic:

- **`guides/` vs `reference/`** — "how to do X" vs "what is X". Both are evergreen, but they answer different reader questions.
- **`plans/` vs `history/completed-plans/`** — active vs shipped. The status header in each plan file is the authoritative signal; when a plan ships, it moves with a date in the filename.
- **`history/`** is for frozen point-in-time records: audits, postmortems, recovery runs. They are referenced, not updated. Each subdirectory or filename includes the date or wave so the temporal context is obvious without opening the file.
- **`apps/`** stays flat per-app because the in-app help system and the `pnpm docs:generate` pipeline both depend on the exact `apps/<name>/{guide,marketing,_narrative,_marketing_hook,mcp-tools}.md` layout.

---

*Built by [Big Blue Ceiling Prototyping & Fabrication, LLC](https://bigblueceiling.com)*
