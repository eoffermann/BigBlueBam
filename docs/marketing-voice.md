# BigBlueBam Marketing Site — Voice & Approach

This is the house style for the marketing site under `site/`. Read it before
writing or editing any section copy. It is built from how the site already
reads, dialed toward something warmer and funnier without losing the
credibility a buyer needs.

## The one-sentence version

We make a serious, deeply-integrated productivity suite, and we talk about it
like people who actually enjoy their work — clear first, clever second, never
clever at the expense of clear.

## Lead with the problem

The site already says what each app *does*. That's table stakes — every rival's
site says what theirs does too. What differentiates us is what we *solve*.
**Open on the problem, then reveal the product as the way out of it.**

The shape of a problem-led beat:

1. **Name the pain first.** The specific, recognizable frustration the reader
   lives with today — the tab they forget to open, the four tools that don't
   talk to each other, the "AI feature" that's a chatbot bolted onto the corner.
   One or two sentences. Make them nod before they read a single feature.
2. **The turn.** Pivot to the product as the obvious answer.
3. **The substance.** Then what it does, plainly, exactly as the structure
   below prescribes.

A problem-led intro reads like we watched the reader's day go sideways and built
the fix. A feature-led intro reads like a spec sheet. Write the former. The pain
you lead with is almost always a competitor's shortcoming, stated as the
reader's lived experience — which is the next section.

## The competition (we know them cold; we rarely name them)

We are opinionated about our software *and* the alternatives, and we keep a
running mental roster of who we're up against. **Every app has several rivals;
the suite as a whole has a few.** That roster stays in our heads, not on the
page — we don't run comparison-chart attack ads or name names. Instead, the
problem we lead with *is* the thing their users gripe about, recast as a pain the
reader already feels. We allude; we don't litigate.

**Do the homework every time.** When we build a new version of the site, search
the web for current, common complaints about the leading tools in each space
(and about all-in-one suites generally), then aim the copy at the ones we
genuinely fix. If users keep saying a tool is "slow," "a labyrinth of settings,"
"nickel-and-dimes you per seat," or "the AI is just a chatbot in the corner" —
and we're actually better there — that's the problem to open on. Claim only what
we can back up (see "Numbers & facts"); a hollow shot is worse than none.

**Why we believe we win — the four we'll stand behind:**

- **Modern architecture.** Built recently, on one coherent stack, as a single
  system — not a decade of acquisitions stitched together with webhooks. It's
  fast, and it's *whole*.
- **AI-first, and not pretending.** Every app is driven by real MCP tools an
  agent can operate with the same authority as a person — not a chat sidebar
  glued onto last year's product. Everyone else can gesture at this; the bolt-on
  shows.
- **Open source.** You can read it, run it, self-host it, and trust it. No black
  box, no hostage data, no "contact sales to export."
- **The blended human/AI workplace.** The bet: tomorrow's business runs on people
  and agents working the *same* surfaces, and we're the single strongest
  contender built for exactly that. We say it with a grin — it's a big claim, and
  we mean it.

**Funny, never bitter.** Poking at the category's absurdities — the seven-tab
workflow, the "AI" that summarizes the doc you just wrote — is some of the best
comedy on the site. Punch up at *the work* and at *the way it's always been
done*, never at the reader and never as a cheap shot at a named rival. Confident
and amused, not resentful.

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

## No em dashes (hard rule)

Do not use the em dash character (the long dash) anywhere in site copy. Because
LLMs overuse it, it now reads as machine-written, and readers notice. Reword the
sentence instead: split it into two with a period, use a comma or a colon, wrap
the aside in parentheses, or join the clauses with "and"/"but". Do not paper over
it by swapping in a hyphen or a spaced hyphen; rewrite so the dash isn't needed.
(En dashes in numeric ranges like 1-5 are fine; this rule is about the em dash
used as a sentence break.) When in doubt, two short sentences beat one with a
dash in it.

## Gate the deep technical dives ("talk nerdy to me")

The landing page sells the outcome, not the plumbing. Keep the home page and its
sections approachable: nearly ELI5, warm, and exciting. Name a capability and say
what it lets you do in plain words ("agents do real work on your boards," "runs
on your own servers, your data stays yours"), then stop. Anyone who wants the
architecture clicks through.

- Mention the impressive tech (MCP tools, the stack, parity) in one plain
  sentence, paired with the benefit. Do not explain the mechanism on the home page.
- Move the deep dive (scoped API keys, RBAC, audit trails, the JSON tool call,
  the full stack list, RLS/JSONB/PubSub, scaling) to the technical page reached
  by a "Talk nerdy to me" button.
- A non-technical buyer modernizing a traditional company, or a tiny startup,
  should feel invited, not quizzed. The CTO/CAIO who wants depth has a clear door
  to it.

Never shy away from the technical details of what makes us better. The depth is a
real differentiator and we are proud of it. The move is to RELOCATE it, never to
bury it: the home page earns the click, the technical page delivers the goods in
full. Most potential customers get freaked out by the plumbing on first contact,
so we lead with what it does for them and keep an obvious door for the people who
want to see how the sausage is made. The technical page can be as dense and proud
as it likes. The home page cannot.

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
