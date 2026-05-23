# AUTODOCUMENTATION_PLAN.md

## Context

BigBlueBam is a 14-app monorepo (Bam, Banter, Helpdesk, Beacon, Brief, Bolt, Bearing, Board, Bond, Blast, Bench, Book, Blank, Bill), each with its own SPA, API, and MCP tools. Today, documentation drifts: existing per-app screenshot scripts at `scripts/screenshots-*.js` duplicate login, navigation, and theme logic; per-app instruction and marketing docs do not yet exist; the README only has skeleton per-app sections; the marketing site at `site/` hardcodes its pages; the 294 MCP tools have no generated catalog. Every UI sweep regresses marketing and docs together because there is no single source of truth.

The goal is a fully automatic pipeline that, on demand, regenerates for every app: screenshots (light and dark), a technical instruction document (the "chapter"), a marketing document (the "brochure"), a per-app in-app Help viewer hookup, an updated README with links, and a repopulated marketing website. A single command triggers the whole thing; multi-agent orchestration handles the narrative writing where templates are not enough.

## What Already Exists (Reuse, Do Not Rewrite)

- [scripts/screenshots-bond.js](scripts/screenshots-bond.js) and 9 siblings: Playwright, hardcoded creds `eddie@bigblueceiling.com` / `BigBlue2026!`, manual theme toggle, manual org routing. Pattern is good; duplication is the problem.
- [apps/e2e/src/auth/auth.setup.ts](apps/e2e/src/auth/auth.setup.ts): battle-tested login and storage-state helpers, idempotent per-app seed steps for Bam, Board, Bolt, Bond, Brief, Banter, Blank, Bill, Blast, Helpdesk. The documentation pipeline should reuse this exact auth setup rather than re-logging in per script.
- [apps/mcp-server/src/lib/register-tool.ts](apps/mcp-server/src/lib/register-tool.ts): `registerTool({name, description, input, returns, handler})` plus `getAllReturnSchemas()`. This is the machine-readable tool catalog; a doc extractor can import each `apps/mcp-server/src/tools/*-tools.ts` module into a harness that captures registrations.
- [scripts/seed-all.mjs](scripts/seed-all.mjs): provides the four-phase seeded demo environment. Screenshots must run against this exact seeded state so URLs like deal cards, dashboards, and tickets resolve.
- `apps/frontend/src/app.tsx:121` theme mechanism: `localStorage.setItem('bbam-theme', 'dark'|'light'|'system')` plus `document.documentElement.classList.add('dark')`. Existing screenshot scripts use the wrong key `'theme'`; the new helper must use `'bbam-theme'` to survive reloads.
- `apps/*/src/lib/markdown.ts` (6 copies): an ad-hoc markdown to HTML converter with XSS sanitization. Consolidating this into `@bigbluebam/ui` gives every app a Help viewer for free.
- [README.md](README.md): already has per-app sections at lines 392 to 823 and a Documentation section at lines 1117 to 1134. The generator will regenerate only the markers-delimited regions inside those sections.
- [site/](site/): Vite plus React 19. Marketing content is currently hardcoded; it will move to reading generated markdown plus screenshots at build time.

## Goals

1. **Zero-touch regeneration.** One command, `pnpm docs:generate`, rebuilds screenshots, per-app instruction docs, per-app marketing docs, README links, and marketing site content from the current state of the codebase plus seeded demo data.
2. **Truth sources stay the code.** MCP tool lists come from `register-tool.ts` registrations. Screenshots come from a running stack. App inventory comes from `apps/*`. Never hand-maintain a list of things the code already knows.
3. **Agent-assisted narrative, deterministic scaffolding.** Scaffolding (tool tables, screenshot embeds, cross-links) is template-generated. Narrative prose (what the app is for, how it fits with others) is written once per app and refreshed by a documentation agent only when the app changes beyond a threshold.
4. **In-app Help uses the same artifacts.** The instruction document is the authoritative help text, rendered in-app by a shared `<HelpViewer>` component.
5. **Light and dark parity.** Every screenshot exists in both themes. The marketing site picks the right variant based on user theme preference.

## Non-Goals

- Video or animated GIF capture. Still images only in v1.
- Translating documentation to other languages.
- Generating per-endpoint REST API reference. The design document already covers that.
- Replacing the authoritative `docs/BigBlueBam_Design_Document.md`. The new docs are complementary: user and marketing facing rather than design facing.

## Output Layout

```
docs/
  apps/
    bam/
      guide.md              Technical instruction doc ("chapter"). Source for in-app Help.
      marketing.md          Less technical, benefit-oriented. Source for marketing site.
      screenshots/
        light/
          01-board.png
          02-sprint-board.png
          ...
        dark/
          01-board.png
          ...
      mcp-tools.md          Auto-generated tool table. Included by guide.md.
      meta.json             App metadata, screenshot inventory, last regen timestamp.
    banter/ ...
    beacon/ ...
    (one directory per app)
  auto/
    screenshot-manifest.json   Global manifest, every capture with hash, theme, dimensions.
    regen-log.md               Running log of documentation regenerations with timestamps.
site/
  src/
    content/                Symlinks or build-time copies of docs/apps/*/marketing.md
    assets/screenshots/     Symlinks or build-time copies of docs/apps/*/screenshots/
```

Screenshots live inside `docs/apps/*/screenshots/` so the instruction and marketing markdowns can use simple relative paths that work both on GitHub rendering and in the in-app viewer.

## Architecture

### Five pipeline stages

```
stage 1  Seed             docker compose --profile seed run --rm seed
stage 2  Capture          pnpm docs:screenshots           per-app Playwright runs
stage 3  Extract          pnpm docs:extract               MCP catalog + app metadata
stage 4  Compose          pnpm docs:compose               Markdown generation, agent narrative refresh
stage 5  Publish          pnpm docs:publish               README rewrite, site content sync
```

`pnpm docs:generate` runs all five in order. Stages 2, 3, 4 are independent across apps and parallelizable.

### Stage 1: Seed

Already implemented. Documented here only to make clear that the pipeline assumes a live, seeded stack at `http://localhost`. The runner refuses to continue if `GET /b3/api/health` returns non-200.

### Stage 2: Capture

**New package: `@bigbluebam/docs-capture`** at `packages/docs-capture/`.

Why a package rather than a script: so that per-app capture modules can import typed helpers and the marketing site build can re-invoke individual scenes if desired.

It exports:

- `createDocPage(browser, {theme, app})`: returns a Playwright page already authenticated (reuses `apps/e2e/.auth/admin.json` if fresh, otherwise re-logs in via [apps/e2e/src/auth/auth.helper.ts](apps/e2e/src/auth/auth.helper.ts)).
- `setTheme(page, 'light' | 'dark')`: writes `bbam-theme` to localStorage and toggles `dark` class on `document.documentElement`, then reloads. This is the one place that mechanism lives.
- `ensureOrg(page, slug)`: resolves the org via the slug used by `SEED_ORG_SLUG`, not a hardcoded UUID.
- `snap(page, {file, label, waitFor?})`: screenshot with consistent viewport (1440 by 900), PNG, written to both light and dark output folders once wrapped by the theme loop.
- `runScenes(app, scenes)`: iterates a declarative list of scenes, each scene being `{id, label, route, setup?(page), screenshot_after?}`. Runs each scene twice, once per theme.

**Per-app scene files** at `packages/docs-capture/src/apps/{app}.scenes.ts`. A scene file looks like:

```ts
export const bondScenes: Scene[] = [
  { id: '01-pipeline', label: 'Pipeline board', route: '/bond/', waitFor: '[data-deal-id]' },
  { id: '02-contacts', label: 'Contacts list', route: '/bond/contacts' },
  { id: '03-deal-detail', label: 'Deal detail', route: '/bond/', setup: async (p) => { /* click first card */ } },
  // ...
];
```

The existing `scripts/screenshots-*.js` files become the seed content for these scene files. Each is one pass of transcription plus deduplication.

**Output guarantees per run**:

- Every scene produces exactly two PNGs, `docs/apps/{app}/screenshots/light/{id}.png` and `.../dark/{id}.png`.
- A `meta.json` lists every screenshot with SHA-256, dimensions, theme, label, and capture timestamp.
- If a scene fails to capture, the run fails the app but continues with other apps so one broken scene does not block the whole rebuild.

### Stage 3: Extract

**New script: `scripts/docs/extract.mjs`**.

Responsibilities:

1. **MCP catalog extraction.** Import each `apps/mcp-server/src/tools/*-tools.ts` module into a harness that stubs `McpServer.tool()` to record `{name, description, input, returns}`. Group by app using the module file name (bond-tools.ts to bond). Write per-app `docs/apps/{app}/mcp-tools.md` as a sorted markdown table with tool name, description, input schema summary, return schema summary.
2. **App metadata.** For each app, resolve its nginx path, API port, number of routes, number of Drizzle schema modules, seeder presence, E2E coverage. Read this from the filesystem, not from CLAUDE.md (which drifts). Write into `docs/apps/{app}/meta.json`.
3. **Change detection.** Hash each app's `src/` tree. Compare to the previous run's `meta.json`. Emit a "changed apps" list for Stage 4 to decide which narratives need agent refresh vs which can reuse the prior text.

### Stage 4: Compose

**New script: `scripts/docs/compose.mjs`**.

Two kinds of content are produced per app.

**`guide.md` (technical instruction chapter).** Assembled from:

- A markdown frontmatter block (title, app name, regen timestamp).
- A hand-written or agent-refreshed `_narrative.md` partial stored at `docs/apps/{app}/_narrative.md`. This is the only file that carries long-form prose; it is versioned in git and regenerated by an agent only when the app's src tree has materially changed.
- Auto-inserted "Walkthrough" section that loops over screenshots and embeds each with its label.
- Auto-inserted "MCP Tools" section via include of `mcp-tools.md`.
- Auto-inserted "Related apps" section derived from cross-references in other narratives.

**`marketing.md` (brochure).** Shorter, benefits-first. Agent-generated from the guide plus a hand-written tagline file `_marketing_hook.md`. Embeds hero and two supporting screenshots only.

**Agent orchestration.** A lightweight orchestrator at `scripts/docs/compose.mjs` invokes the Claude API (using `@bigbluebam/shared` API client patterns) only when:

- A `_narrative.md` does not exist yet, or
- Stage 3 reports the app's source tree changed beyond 200 modified lines since the last regeneration.

Otherwise, `_narrative.md` is reused verbatim. This keeps runs cheap and deterministic. The prompt handed to the documentation agent is a single template with placeholders for app name, route, feature list, MCP tool names, and screenshot labels. The agent returns markdown; the pipeline writes it to `_narrative.md`. No multi-turn back-and-forth in v1.

**Agent roles (each is a one-shot Claude API call, not a subagent in this CLI):**

- `doc-writer`: writes or refreshes `_narrative.md` for one app. Inputs: app metadata, MCP tool list, screenshot labels, related apps. Output: markdown body only.
- `marketer`: writes `marketing.md` for one app. Inputs: the `_narrative.md` plus a hand-written hook file. Output: shorter marketing markdown.
- `readme-updater`: writes the regenerated per-app section of README.md and the Documentation index block.

Invocation is sequential per app, parallel across apps. Concurrency capped at six to stay inside rate limits.

### Stage 5: Publish

**New script: `scripts/docs/publish.mjs`**.

1. **README rewrite.** Between markers `<!-- AUTODOCS:APP_SECTIONS:START -->` and `<!-- AUTODOCS:APP_SECTIONS:END -->`, insert regenerated per-app card-style summaries with a thumbnail screenshot and links to the guide, marketing doc, and MCP tool reference. Between markers `<!-- AUTODOCS:DOCS_INDEX:START -->` and `<!-- AUTODOCS:DOCS_INDEX:END -->`, rewrite the Documentation section links. Never touch anything outside these markers. If the markers do not yet exist, inject them around the existing per-app sections on first run and commit that change separately.
2. **Marketing site sync.** Copy `docs/apps/*/marketing.md` into `site/src/content/apps/{app}.md` and `docs/apps/*/screenshots/` into `site/public/screenshots/{app}/`. The site already builds with Vite; it gains a new content loader that reads the markdown files at build time.
3. **In-app Help hookup.** Each frontend app gets a `/help` route (or equivalent) that fetches `docs/apps/{app}/guide.md` via a static endpoint exposed by nginx at `/docs/apps/{app}/`. The shared `<HelpViewer>` component lives in `@bigbluebam/ui` and renders the markdown using the consolidated `markdown.ts` utility.
4. **Manifest and log.** Write `docs/auto/screenshot-manifest.json` (global index of every capture with hash) and append an entry to `docs/auto/regen-log.md` with timestamp, duration per stage, apps changed, scenes captured, and any scene failures.

## Multi-Agent Orchestration at Top Level

A wrapper script, `scripts/docs/generate.mjs`, exposes the same workflow to a calling agent via:

```
pnpm docs:generate --apps bond,bench --skip-seed   # partial rerun for specific apps
pnpm docs:generate                                  # full rebuild
pnpm docs:generate --dry-run                        # plan only, no writes
```

Inside the Claude Code harness, a caller can spawn three agent phases in parallel when doing a large UI sweep:

1. An Explore agent audits which screenshot scenes reference now-missing selectors and files a list.
2. The `doc-writer` agent (one per changed app) refreshes `_narrative.md`.
3. A `review` subagent reads the resulting guides and flags anything that reads as stale or contradicts the current code.

The orchestration is optional. The scripted pipeline is sufficient on its own.

## README Strategy

The README stays human-editable; only two marker-delimited regions are rewritten by the pipeline. This keeps hand-written hero content, vision, quick-start, and architecture diagrams safe. On first run, the pipeline prints a diff of the regions it would insert and exits unless passed `--init` so an author can review the boundaries.

## In-App Help Viewer

A shared React component at `packages/ui/src/help/HelpViewer.tsx` that:

- Fetches `/docs/apps/{appSlug}/guide.md` via standard fetch (served by nginx as static files from the `docs/` directory mounted into the frontend container, or via an `/docs/` route in each app's nginx config).
- Renders markdown via the consolidated `markdownToHtml` plus `sanitizeHtml` utility moved into `@bigbluebam/ui`.
- Supports anchor deep linking so a user can land on "Creating a deal" directly from a contextual Help link.
- Caches via TanStack Query with a 1 hour stale time.

Each frontend app imports it and wires up a `?` keyboard shortcut and a Help menu item.

## Failure Modes and Safeguards

- **Seed state missing.** Pipeline fails fast with a message to run the seeder.
- **Scene selector broken.** That scene is marked failed, screenshot placeholder used (a 1440x900 gray PNG with an "image unavailable" overlay), pipeline continues. The failure is logged in `regen-log.md` and in the per-app `meta.json` so a human can fix it.
- **Agent quota hit.** Composition falls back to reusing the last `_narrative.md`. The run still produces valid docs, just with stale prose for apps that needed refresh.
- **MCP tool extraction fails for an app.** `mcp-tools.md` is written with a "Tool catalog unavailable" notice plus the import error. Guide still assembles.
- **Partial run detection.** The pipeline writes a `.regen-in-progress` lock file. If the previous run crashed mid-flight, the next run detects it and offers a resume or clean restart.

## Security

- Screenshot credentials live in `.env` as `DOCS_CAPTURE_USER` and `DOCS_CAPTURE_PASSWORD`. No hardcoding. The default in `.env.example` points at the seeded `eddie@bigblueceiling.com` user.
- The docs viewer route is authenticated (same session as the app).
- The marketing site receives only `marketing.md` (which by construction contains no customer or internal data), not `guide.md`.

## Verification

A one-time acceptance pass:

1. Run `docker compose --profile seed run --rm seed` against an empty stack and confirm the seeded state renders manually at `http://localhost/b3/` for the documentation user.
2. Run `pnpm docs:generate --apps bond`. Confirm:
   - 3 or more light PNGs and 3 or more dark PNGs appear under `docs/apps/bond/screenshots/`.
   - `docs/apps/bond/guide.md`, `marketing.md`, `mcp-tools.md`, `meta.json` all exist.
   - `mcp-tools.md` lists the 22 Bond tools that `register-tool.ts` knows about.
   - README.md markers now bound a regenerated Bond section.
   - `site/public/screenshots/bond/` contains the copied images.
3. Run `pnpm docs:generate` (all apps). Confirm all 14 app directories populate and the run completes in under 15 minutes on a developer machine.
4. Open the Bond frontend, press `?`, and confirm the Help viewer renders `guide.md` including screenshots.
5. Rerun `pnpm docs:generate` with no source changes and confirm no agent API calls are made (since nothing changed) and PNG hashes stay stable.

## Open Questions

- **Per-app screenshot cadence.** Do marketing screenshots need to refresh on every PR, or only on tag? Recommendation: per-PR for guide images (cheap, reuses CI Playwright), per-tag for marketing images (hero shots need human review).
- **Hosting the docs viewer assets.** Should the `docs/` tree be served by each app's nginx, by the shared frontend container, or by a dedicated static service? Recommendation: by each app's nginx via a shared volume mount of `docs/`, to keep the deployment model unchanged.
- **Whether to version screenshots in git.** Large and binary, but useful for diff review. Recommendation: yes, versioned. With 14 apps and 5 scenes each, 140 PNGs at roughly 150 KB each is about 20 MB, manageable.

## Critical Files to Create or Modify

New files:

- `packages/docs-capture/` (new package): shared Playwright helper, scene runner.
- `packages/docs-capture/src/apps/{app}.scenes.ts` (14 files): per-app scene definitions.
- `scripts/docs/extract.mjs`: MCP catalog and app metadata extraction.
- `scripts/docs/compose.mjs`: markdown assembly plus agent invocations.
- `scripts/docs/publish.mjs`: README rewrite plus site sync.
- `scripts/docs/generate.mjs`: top-level orchestrator.
- `packages/ui/src/help/HelpViewer.tsx`: shared in-app Help component.
- `docs/apps/{app}/_narrative.md` and `_marketing_hook.md` (28 files initially): hand-seeded or agent-seeded long-form prose.

Modified:

- [README.md](README.md): add the two marker blocks on first run.
- [site/](site/) pages: add content loader reading `src/content/apps/*.md`.
- `apps/*/src/lib/markdown.ts`: collapse into `@bigbluebam/ui` import.
- Each frontend app's router: add a `/help` route using `HelpViewer`.
- `.env.example`: add `DOCS_CAPTURE_USER` and `DOCS_CAPTURE_PASSWORD`.
- `package.json`: add `docs:*` scripts.

## Rollout Plan

1. **Week 1.** Build `packages/docs-capture`, port the Bond screenshot script as the first consumer. Confirm light and dark parity. No markdown generation yet.
2. **Week 2.** Port remaining 13 apps' screenshot scripts into scene files. Delete the old `scripts/screenshots-*.js` files.
3. **Week 3.** Build Stage 3 (extract) and Stage 4 (compose). Ship guide.md and mcp-tools.md for all apps. Hand-author first-pass `_narrative.md` rather than agent-writing, to avoid a cold-start full-codebase prose invocation.
4. **Week 4.** Build Stage 5 (publish), in-app Help viewer, marketing site content loader. Hook up README markers.
5. **Week 5.** Enable agent refresh mode for `_narrative.md`. Cut the first end-to-end `pnpm docs:generate` run.
