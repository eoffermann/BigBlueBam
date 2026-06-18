# BigBlueBam Marketing Site — Voice & Approach

This is the house style for the marketing site under `site/`. Read it before
writing or editing any section copy. It is built from how the site already
reads, dialed toward something warmer and funnier without losing the
credibility a buyer needs.

## The one-sentence version

We make a serious, deeply-integrated productivity suite, and we talk about it
like people who actually enjoy their work — clear first, clever second, never
clever at the expense of clear.

## Voice attributes

- **Warm, not corporate.** Write like a sharp colleague explaining the thing
  over coffee, not like a press release. Contractions are good. "You" is the
  hero of every sentence.
- **Confident, not boastful.** State what the product does plainly. The
  capability is impressive on its own; let it be. Avoid "revolutionary,"
  "game-changing," "best-in-class," and other adjectives that survive only in
  the absence of facts.
- **Specific, not vague.** "Drag a task across configurable phases" beats
  "powerful workflow management." Real numbers (tool counts, view names, stage
  names) are more persuasive than superlatives — and we have them.
- **Light, with a wink.** Every page should give the reader at least one reason
  to smile: a playful subhead, a self-aware aside, an unexpected verb. The humor
  is dry and quick. It lands and gets out of the way.

## The smile rule

**Every page earns at least one genuine smile.** Usually it lives in:

- a **subhead** ("Relationships, tracked" → keep that energy),
- a **caption** under a screenshot (one wry line about what's on screen),
- or a **feature-card description** that ends with a small human observation.

The body that explains the actual feature stays straight. We set the joke up in
the heading or the caption, then deliver the substance underneath it. Think
clever signage on an otherwise well-run shop — not a comedian who won't let you
read the menu.

## Humor guardrails

- **Punch up at the work, never at the user.** Jokes are about deadlines,
  meetings that should've been email, the chaos of a backlog — shared
  experiences, never the reader's competence.
- **One joke per beat.** A witty subhead followed by a witty caption followed by
  a witty bullet is exhausting. Alternate: playful heading, plain body.
- **Never sacrifice scannability.** A buyer skimming for "does it do X" must
  find the answer fast. If a clever line obscures the feature, cut the clever.
- **Keep it evergreen.** Avoid memes or references that age in a quarter.
- **No inside jokes the reader can't get.** See the screencap rule below.

## The screencap rule (important)

The product screenshots feature a fictional, good-natured castaway travel
company as their demo data — that's deliberate, it makes the imagery warm and
memorable instead of "Acme Corp / Test User 1." **Do not name or reference that
theme in page copy.** The visuals carry the personality; the words stay about
the product. A reader who never zooms into a screenshot should still find the
copy funny and clear on its own. Captions may gesture at what's playfully on
screen ("a deal pipeline that's actually moving") without explaining the bit.

## Structure: anatomy of an app section

Keep the established shape — it works and it's consistent across the suite:

1. **Badge** — the category ("CRM", "Knowledge Base", "New").
2. **Headline** — short, punchy, ideally the smile moment. 3–6 words.
3. **Intro paragraph** — 2–4 sentences. What it is, who it's for, and the one
   thing that makes it different (usually: it lives alongside the rest of the
   suite, and AI agents drive it through MCP tools). End with the real tool
   count.
4. **Screenshots** — a hero `FloatingFrame` then a 2-up (or 2×2) grid of
   `FloatingFrame`s, each with a one-line caption. **Show the product.** We have
   marketing-grade captures now; use 3–5 per section. Reference the current
   images at `/screenshots/<app>/light/<NN>-<slug>.png`.
5. **Feature cards** — 4–6 cards (icon, title, 1–2 sentence description). Cover
   the headline capabilities including anything new. The AI/MCP card always
   states the accurate tool count and a couple of representative tools.
6. **CTA bar** — "Try <App>" button + the "Served at `/<app>/`" line noting it
   shares auth and the project model with its siblings.

## Numbers & facts (keep them honest)

- Pull MCP tool counts from each app's `docs/apps/<app>/meta.json`
  (`mcp_tool_count`). They drift; verify before writing. Do not invent.
- Feature claims come from `docs/apps/<app>/_narrative.md` and `help.md`. If the
  narrative says it ships, we can say it ships. If it's a stub, we don't imply
  otherwise.
- Cross-product links (Bond → Bam projects, Board sticky → Bam task, etc.) are a
  core selling point — name the actual sibling apps.

## Words we like / words we avoid

Like: *alongside, lives in, one click, carries over, no tab-switching, drag,
queue, board, pipeline, in plain terms, and yes — agents can do it too.*

Avoid: *synergy, leverage (as a verb), seamless, robust, cutting-edge,
unlock (overused), empower, supercharge, "in today's fast-paced world."*

## Examples (flat → us)

- Flat: "Bond provides robust CRM capabilities for managing customer
  relationships." → Us: **"Relationships, tracked."** Then: "A visual deal
  pipeline that lives next to your project board, not in a separate tab you
  forget to open."
- Flat: "Bill offers comprehensive invoicing features." → Us: **"Get paid
  without the dread."** Then: "Invoices, expenses, recurring billing, and PDFs —
  generated from the work you already tracked."
- Flat caption: "Screenshot of the pipeline board." → Us: "A pipeline with deals
  actually moving through it — weighted value per stage, no wishful thinking."

## Per-page personality

- **Home** — the warmest page. The hero sets the whole tone; one confident,
  funny line about a suite of sixteen apps that act like one.
- **/work, /communicate, /sales, /operations** — each thematic page opens with a
  line that frames the category with a grin, then lets the app sections deliver.
- **/docs, /deploy** — practical pages; humor dialed down to a single warm aside
  so they stay genuinely useful.

When in doubt: clear, specific, and one good smile. Ship that.
