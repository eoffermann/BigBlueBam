---
name: suite-help-system
description: >-
  Standard for building and maintaining BigBlueBam's unified in-app help system:
  a "(?)" Help Center launched from every app's top bar (TOC, search, index,
  cross-references) sourced from docs/apps/<app>/help.md, plus right-click
  "Help: <element>" deep-links on UI elements that the help docs reference.
  Use when building, extending, or updating the help feature for any app.
---

# Suite Help System Standard

The help system turns the per-app `docs/apps/<app>/help.md` files (authored via the
`help-doc-authoring` skill) into a live, searchable, cross-linked in-app help
experience, with **no second copy of the content**. The markdown is the single
source of truth; everything else is derived or one-line wiring. That is the whole
point: to update help, you edit `help.md` and regenerate; you never hand-maintain
the UI.

## Architecture (the contract)

```
docs/apps/<app>/help.md                  <- authored content (single source of truth)
        │  (build step: help-index-builder)
        ▼
docs/apps/<app>/help-index.json          <- DERIVED: toc, sections, label->anchor, crossrefs
        │  (served by nginx alongside help.md at /docs/apps/<app>/)
        ▼
packages/ui/help-center.tsx              <- ONE shared Help Center component (overlay)
        │  fetches help.md + help-index.json, renders markdown, TOC, search, index
        ├── HelpTrigger ("(?)" icon, tooltip "Help")   -> wired 1 line into each app top bar
        └── useElementHelp / contextmenu hook          -> right-click "Help: <label>" deep-link
```

Four pieces, in dependency order:

1. **Content** - the existing `docs/apps/<app>/help.md`. Already served as a static
   file by the frontend nginx image (`/docs/apps/<app>/help.md`). Do not duplicate it.
2. **Index** - `docs/apps/<app>/help-index.json`, generated from `help.md` by the
   `help-index-builder` agent / `scripts/help/build-help-index.mjs`. Shape:
   ```json
   {
     "app": "blast",
     "title": "Blast",
     "toc": [{ "anchor": "send-a-campaign", "title": "Send a campaign", "level": 2 }],
     "sections": [{ "anchor": "send-a-campaign", "title": "...", "text": "plain text for search" }],
     "labels": { "Send Now": "send-a-campaign", "Save Draft": "create-a-campaign" },
     "crossrefs": [{ "app": "bond", "title": "Bond" }]
   }
   ```
   - `anchor` is the GitHub-style slug of the heading (lowercase, hyphenated).
   - `labels` is the key to right-click help: every exact UI label the doc **quotes**
     (markdown `**"Send Now"**`, `**Apply layout**`, backtick code spans for fields)
     mapped to the anchor of the nearest enclosing section. The doc convention
     (help-doc-authoring: "use the app's real UI labels, exactly as rendered") makes
     this reliable. A label documented in two sections maps to the first; record the
     collision in the build report.
   - Regenerate on every `help.md` change. CI runs the builder and fails if any
     `help-index.json` is stale (drift guard, like `db:check`).
3. **Help Center component** - ONE component in `packages/ui/help-center.tsx`
   (mirror the `notifications-bell.tsx` pattern: self-contained, aliased per app via
   `@bigbluebam/ui/help-center`, public props minimal). It:
   - fetches `/docs/apps/<app>/help.md` + `/docs/apps/<app>/help-index.json`,
   - renders the markdown with the existing `@bigbluebam/ui/markdown`,
   - shows a left **TOC** (from `toc`), a **search** box (client-side over `sections`),
     an **Index** / **cross-references** panel (jump to other apps' help),
   - opens to a given anchor (deep-link) and supports in-doc + cross-app navigation,
   - is a styled overlay (does not navigate away from the app).
   `HelpTrigger` is the "(?)" button (tooltip **Help**) that opens it.
4. **Right-click element help** - a shared mechanism (a `contextmenu` augmentation in
   the app layout, or a `useElementHelp` hook) that, on right-click, walks up from the
   event target to find a label (visible button text, `aria-label`, or an explicit
   `data-help-label` attribute), looks it up in the app's `labels` map, and - only if
   found - adds a **"Help: <label>"** item that opens the Help Center to that anchor.
   Coverage is driven entirely by the docs: a label gets right-click help iff the doc
   documents it. Improving coverage = improving `help.md`, not editing components.

## Per-app integration (what "wiring an app" means)

For one app, the `help-ui-integrator` does exactly this and no more:
1. Ensure `docs/apps/<app>/help-index.json` exists (run the index builder first).
2. Add the `@bigbluebam/ui/help-center` Vite alias to `apps/<app>/vite.config.ts`
   (same as the bell alias).
3. Render `<HelpTrigger app="<app>" />` in the app's top bar, next to the other
   header controls (Launchpad / OrgSwitcher / NotificationsBell / UserMenu) - the
   established header slot. Bam = `apps/frontend`; satellites = `apps/<app>`.
4. Mount the right-click help augmentation once at the layout root (or wrap the main
   content) so `contextmenu` resolves element labels against the index.
5. Do not touch feature components. Right-click coverage comes from the index; if a
   key element has no usable label, add a `data-help-label="<exact doc label>"` to
   that element only.

## Maintenance flow (why this is easy to update)

- **Change help text:** edit `docs/apps/<app>/help.md` (use `help-doc-authoring`),
  then re-run the `help-index-builder`. The Help Center and right-click help update
  with zero component edits.
- **Add a new app:** author its `help.md`, run the index builder, run the
  `help-ui-integrator` for that app. Two agent calls.
- **New UI label should get right-click help:** document it in `help.md` with its
  exact rendered label. The next index build picks it up.
- **CI:** the index drift guard regenerates and diffs `help-index.json`; a stale
  index fails the build, so the index can never silently lag the docs.

## Acceptance checklist (an app's help is "done" when all hold)

- [ ] `docs/apps/<app>/help-index.json` exists and is current (builder produces no diff).
- [ ] The "(?)" Help icon renders in the app's top bar with a **Help** tooltip and opens the Help Center.
- [ ] The Help Center shows the app's help with a working TOC, search, and cross-reference jumps.
- [ ] Right-clicking an element whose label the doc documents shows "Help: <label>" and opens the right section.
- [ ] Right-clicking an undocumented element shows no help item (no false entries).
- [ ] No second copy of the content exists; the Help Center reads `help.md` + the index.
- [ ] The shared component is used (no per-app fork of the Help Center).

## Hard rules

- The markdown stays the single source of truth. Never fork content into a component.
- One shared Help Center component for all apps; per-app differences are data (the
  index) and one-line wiring, never a forked UI.
- The index is generated, never hand-edited.
- Build in dependency order: index builder -> shared component -> per-app wiring.
  Wire one app end-to-end as a reference before fanning out to the rest.
