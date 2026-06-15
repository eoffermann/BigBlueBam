# Suite help system - notes and sharp edges

The unified in-app help system: a "(?)" Help Center in every app's top bar (TOC,
search, cross-references, deep-link anchors) plus right-click "Help: <element>"
on documented controls. Authoritative standard: `.claude/skills/suite-help-system/SKILL.md`.

## How it fits together

```
docs/apps/<app>/help.md                 authored content (single source of truth)
   -> scripts/help/build-help-index.mjs  (pnpm help:index)
docs/apps/<app>/help-index.json         DERIVED: { title, toc, sections, labels, crossrefs }
   -> packages/ui/help-center.tsx        ONE shared component (Vite alias per app)
        HelpTrigger     the "(?)" icon + the right-click listener (one thing to wire)
        HelpCenter      controlled overlay variant
        openHelpCenter  programmatic open
        slugify         canonical heading slug
```

Both `help.md` and `help-index.json` are served statically by nginx at
`/docs/apps/<app>/` (Dockerfile COPY of `docs/apps/`, with a compose bind mount
overlaying it so edits show without a frontend rebuild). The component fetches
them at runtime; there is no second copy of the content.

## Maintenance flow

- **Edit help text:** change `docs/apps/<app>/help.md`, then `pnpm help:index`.
  The Help Center and right-click coverage update with zero component edits.
  CI (`.github/workflows/lint.yml` -> `pnpm help:check`) fails if any index is stale.
- **Wire a new app:** add the `@bigbluebam/ui/help-center` alias to its
  `vite.config.ts` and render `<HelpTrigger app="<app>" />` in its top-bar layout.
  That is the whole wiring (right-click is installed by HelpTrigger itself).

## Sharp edges

1. **Slug parity is load-bearing.** `slugify()` in `packages/ui/help-center.tsx`
   MUST stay byte-for-byte identical to the `slugify` in
   `scripts/help/build-help-index.mjs`. The index stores anchors from the build
   script; the component re-slugs the rendered headings with its own copy so TOC,
   search, and right-click deep-links land. If they drift, links silently miss.
   (Note: this is a THIRD slug - `packages/ui/markdown.ts`'s heading-id generator
   differs slightly, strips leading/trailing hyphens - which is why the component
   re-slugs headings after render rather than trusting markdownToHtml's ids.)

2. **Relative asset URLs are rewritten at render time.** `help.md` references
   screenshots as `screenshots/light/x.png`. Those would resolve against the SPA
   route and 404, so the component rewrites relative `img`/`a` URLs to
   `/docs/apps/<app>/...` in a post-render effect. New relative-link shapes in
   help.md need to stay relative (no leading slash) to be rewritten.

3. **Blockquote support was added to the shared markdown renderer.** Every help.md
   leads with a `>` blockquote intro; `packages/ui/markdown.ts` now folds leading
   `>` lines into `<blockquote>`. This renderer is also used by Banter messages -
   the change is standard markdown and low-risk, but it is shared, so test Banter
   message rendering if you touch the line-by-line loop again. There are no unit
   tests on `markdownToHtml` (grep confirmed) - add some if you extend it.

4. **Right-click coverage is only as good as the labels map.** A control gets
   right-click help iff its visible text / `aria-label` / `title` / `data-help-label`
   exactly matches a `labels` key in the index, and a label only enters the index
   if help.md quotes it in bold. The resolver walks up 6 ancestors and only reads
   textContent for compact interactive elements (<= 60 chars) to avoid matching
   paragraphs. To document a new control, quote its exact rendered label in help.md.

5. **Index label collisions are expected.** A label quoted in two sections maps to
   the first (the build prints a collision count per app, e.g. helpdesk has 59).
   This is by design - right-click jumps to the first documenting section. If a
   collision points somewhere unhelpful, reword one of the quotes in help.md.

6. **The help agents/skill register on session start.** `help-index-builder`,
   `help-ui-integrator`, and `help-system-reviewer` (`.claude/agents/*.md`) were
   authored this session, so they were not yet in the live agent registry and the
   16-app wiring was done directly instead of via the integrator agent. They will
   be dispatchable in future sessions.

## Verifying

`node scripts/help/smoke-help-center.mjs` (local stack, Bam) asserts: icon renders,
overlay opens, content + TOC render, deep-link anchor resolves, search returns
results, and the right-click resolver matches a live index label. It needs a
loginable Bam admin (set `DOCS_CAPTURE_USER` / `DOCS_CAPTURE_PASSWORD`).
