---
name: suite-brainstorm
description: Run a competitive, multi-agent brainstorming session that selects the next app the BigBlueBam suite should build, then produces a hardened design spec for it. Seven "ideator" seats each propose five adjacent, AI-native apps; they debate, negotiate, submit one each, merge overlaps, and vote (no self-votes) to a single winner. The whole session is logged to docs/brainstorming/<stamp>_BRAINSTORMING_SESSION.md, and the winner gets a full design spec (docs/brainstorming/<stamp>_APP_DESIGN_<appname>.md) drafted and then hardened by five adversarial reviewers. Use when asked to brainstorm / pick / spec the suite's next app.
---

# Suite brainstorm - seven seats → debate → merge → vote → winner → hardened spec

You are the **orchestrator** of a competitive brainstorming session whose single
output is the next app BigBlueBam should build, plus a build-ready design spec for
it. You run the whole protocol below, relay every message between seats (seats
never talk directly), and keep the session document current at each step. The
seats are stateful `brainstorm-ideator` subagents - spawn each once, then continue
it across rounds with **SendMessage** so it keeps its context and identity.

The prize is deliberately scarce: seven seats, one winner. Reward **innovation**
and **customer fit**. A clone of an existing product, or a CRUD app with a chatbot
bolted on, is a losing idea by construction - push the seats toward AI-native,
adjacent, genuinely-new capabilities that move the suite forward.

**Breadth before depth - this is a hard steer, not a preference.** The suite wins
by covering the whole surface of how a small-to-medium services firm runs, NOT by
stacking a third and fourth app onto a subject area two apps already serve. Two
failure modes to actively design against every session:

- **Near-duplication of an existing app.** An idea whose core job substantially
  overlaps an app already in the suite (a second CRM, a second knowledge base, a
  second contract/scope/margin monitor, a second analytics layer) is a losing idea
  by construction, no matter how well-argued. "Adjacent + reuses the platform" must
  not collapse into "a narrow variant of something we already shipped." When in
  doubt, name the closest existing app and force the seat to articulate what makes
  its idea a *different category*, not a better version of that app.
- **Piling onto an already-dense category.** Even a non-duplicate that lands in a
  subject area the suite already covers well (contracts/finance/billing, project/
  task, chat/knowledge/docs) is disfavored versus an idea that opens a category the
  suite barely touches. Prefer the app that adds a new leg to the stool over the app
  that thickens a leg we already have. Fleshing out coverage beats going all-in on
  one narrow subject area.

The coverage census (Setup step 4) is where you turn this into a concrete, per-session
steer; the vote (Phase 5) scores coverage contribution explicitly.

## Subagents this skill drives

- **brainstorm-ideator** - spawn **exactly seven**, one per innovation lens. Each
  proposes five apps and then defends/aligns/opposes/revises across every round.
  Drive them with SendMessage; never re-spawn (that would wipe the seat's memory).
- **brainstorm-spec-writer** - one seat, invoked after a winner is chosen and
  again for each adversarial revision round. Writes/updates the design spec file.
- **brainstorm-spec-adversary** - spawn **five**, one per focus (design, security,
  stability, best-practices, infrastructure), to pressure-test the spec.

## Setup - stamp, scaffold, assign lenses

1. **Timestamp.** Read the current date/time from the environment and form a
   stamp `YYYY_MM_DD_HH_MM` (zero-padded, 24h). Use it for both output filenames.
   Never hardcode a date.
2. **Output location.** Create `docs/brainstorming/` if absent. The two documents
   are:
   - `docs/brainstorming/<stamp>_BRAINSTORMING_SESSION.md` (the running log)
   - `docs/brainstorming/<stamp>_APP_DESIGN_<appname>.md` (written later)
3. **Seed the session doc** with a header (title, stamp, one-line purpose) and an
   empty section per phase below. You append to this file at the end of **every**
   phase - verbatim seat replies, negotiation transcripts, strategies, vote
   tables. It must be readable by someone who watched none of the tool calls.
4. **Coverage census & whitespace steer (do this BEFORE spawning seats).** Take a
   census of what the suite already covers so the session pushes into whitespace
   instead of re-serving a dense area. Read the authoritative current roster from
   `LAUNCHPAD_CATALOG` in `apps/api/src/routes/system-settings.routes.ts` (plus the
   app inventory in `CLAUDE.md`), and any in-flight app from the newest
   `docs/brainstorming/<stamp>_APP_DESIGN_*.md` and the `.autonomous-logs/autonomous-cycle.lock.json`
   (the just-picked app is not on the Launchpad yet but still counts as covered).
   Then, in the session doc under a "Coverage census" heading, write:
   - **A category map:** bucket every existing app (and the in-flight one) into the
     functional category it serves (e.g. project/task, chat/community, knowledge,
     docs, workflow-automation, CRM, email/marketing, analytics/metrics, scheduling,
     forms, billing/finance, contracts/compliance, diagrams, DAM/storage, media
     review, observability, identity/CDP, virtual-office, helpdesk, ...). Mark each
     category **dense** (2+ apps), **covered** (1 app), or **whitespace** (0 apps).
   - **The whitespace list:** the categories a small-to-medium services firm needs
     that the suite has little or nothing for yet. Think broadly - HR/people-ops,
     recruiting/ATS, learning/enablement, procurement/vendor-spend, inventory/assets,
     field-service/dispatch, IT/asset management, GRC/security-compliance, customer
     feedback/surveys, community/forum, product/roadmap, expense/travel, e-signature,
     payroll, and so on. This list is derived fresh each session, not hardcoded.
   - **The per-session steer** you will hand every seat: "prefer the whitespace
     categories; a near-duplicate of an existing app or a third app in a dense
     category is disfavored." Name the currently-dense categories explicitly so the
     seats know what NOT to pile onto.
5. **Assign seven distinct lenses**, one per seat. Use these unless the user asks
   for others. Bias each lens toward the whitespace from step 4 (e.g. Seat D's
   vertical, and any lens, should reach into an under-served category rather than a
   dense one):
   - Seat A - **AI-native automation & autonomous agent workflows**
   - Seat B - **Data, intelligence & analytics**
   - Seat C - **Communication, collaboration & community**
   - Seat D - **A vertical / industry wedge** (pick one under-served vertical)
   - Seat E - **Operator / developer experience & platform tooling**
   - Seat F - **Engineering & Software Development**
   - Seat G - **Creative & Marketing**

## Phase 1 - Ideation (seven seats × five apps)

Spawn all seven `brainstorm-ideator` agents **in one message** (parallel). Give
each its seat id, its lens, the rubric reminder (not a clone; AI-native; real
wedge; adjacent + reuses the platform), **the coverage census from Setup step 4 -
the category map, the whitespace list, and the explicit "prefer whitespace; a
near-duplicate of an existing app or a third app in a dense category is disfavored"
steer, with the dense categories named** - the naming convention (single word,
"B-" alliterative family preferred), and the required output shape (see the agent
def). Tell each seat that at least the majority of its five proposals must land in
a whitespace or covered (not dense) category, and each proposal must name the
closest existing app and say why it is a different category, not a better version
of it. Collect each seat's five-app block.

Append all five blocks **verbatim** to the session doc under "Phase 1 - Initial
proposals," labeled by seat and lens.

## Phase 2 - Debate

Send **every** seat, via SendMessage, the other six seats' five-app blocks. Ask
each to take an align / oppose / ignore stance on the others' relevant apps, to
revise its own five if warranted, and to return its updated five-app block plus
**Debate notes** (its calls + one-paragraph strategy). Its standing goal: land at
least one app in the Final 7.

Run **one full debate round** by default; run a second only if the ideas are
still colliding hard and another round would sharpen them (say why in the doc).
Append every seat's debate reply and revised block verbatim under "Phase 2 -
Debate."

## Phase 3 - Selection (seven submissions)

SendMessage each seat: pick your single strongest app (current, post-debate
description) and submit it as `SUBMISSION - Seat X`. Collect all seven submissions.
Append them verbatim under "Phase 3 - Submissions."

## Phase 4 - Overlap resolution (orchestrator judgement)

**First, screen every submission against the EXISTING suite (not just against each
other).** Using the coverage census, for each submitted app name the closest existing
app (or in-flight app) and judge overlap: if its core job substantially duplicates an
app already in the suite (a second CRM / knowledge base / contract-scope-margin
monitor / analytics layer / etc.), it is **disqualified here** - record it in the doc
as "cut for near-duplication of `<existing app>`" with a one-line reason. A polished
argument does not save a near-duplicate; the whole point of the session is to add a
category, not thicken one. (If the seat believes it is genuinely a different category,
that argument had to be made in its proposal; re-litigating it here does not reopen the
cut.) Then compare the surviving submissions pairwise. Classify each overlapping pair:

- **Perfect overlap** (same app, different words): **collapse** into one entry.
  Note in the doc which two submissions collapsed and keep the stronger framing.
- **Very similar but not identical**: open a **merge negotiation** between exactly
  those two seats. Tell both: negotiate a single merged app description; you have
  at most **10 total turns between you**; if you cannot find common ground the app
  is **discarded**. Relay each turn between them via SendMessage (this is where
  seats-don't-talk-directly matters - you carry every message). Stop when they
  return a `MERGED:` block both accept, or at turn 10 → discard and record it.
- **Distinct**: both continue unchanged.

Record the full merge transcript (every relayed turn) and each outcome under
"Phase 4 - Overlap resolution." After this phase you have **1–7 surviving apps**.

**Short-circuit:** if exactly **one** app survives Phase 4, it **wins** outright -
skip Phase 5, note the walkover in the doc, and go to Phase 6.

## Phase 5 - Final vote

SendMessage all seven seats the final slate of surviving apps (with current
descriptions), **each tagged with the census category it lands in and whether that
category is currently whitespace / covered / dense**. Each seat scores **every**
finalist **1–5** and **must abstain on any app it owns or co-owns** (no self-votes).
Instruct seats that **coverage contribution is an explicit scoring dimension**: an app
that opens a whitespace category should score higher, all else equal, than an equally
good app that thickens an already-dense category. Collect the scorecards.

Tally points per app. Rules:

- **Winner = highest total.** Record the full matrix (seat × app) in the doc.
- **Tie at the top:** delete the **lowest-scoring** app from the slate and run
  **another vote round** on the remainder (same rules). Repeat until the top is
  untied. If a tie cannot break because only tied apps remain, run one more round;
  if still tied, break it by the rubric (most innovative + best fit) **with coverage
  contribution as the decisive tiebreak - the app that opens a whitespace category
  beats the one that thickens a dense category** - and record your reasoning explicitly.

Append every vote round's matrix and the running tally under "Phase 5 - Voting,"
then declare the **winner** with its final description.

## Phase 6 - Design spec (draft → adversarial hardening)

1. **Draft.** Invoke `brainstorm-spec-writer` with the winner's final description
   and the output path `docs/brainstorming/<stamp>_APP_DESIGN_<appname>.md` (use
   the winning app's chosen single-word name, lowercased, for `<appname>`). It
   writes the full spec grounded in the real monorepo (maximal reuse).
2. **Adversarial round.** Spawn all five `brainstorm-spec-adversary` agents **in
   one message**, one per focus (design, security, stability, best-practices,
   infrastructure), each pointed at the spec path. Collect their ranked findings.
3. **Fold in.** Send the batched findings to `brainstorm-spec-writer` (continue it
   via SendMessage) to accept/adapt/reject each and rewrite the spec in place,
   with a Changelog.
4. **Repeat** the adversarial → fold-in loop until a round returns **no new
   blocker or major findings** (typically 2–3 rounds; cap at 3 unless the user
   asks for more). Append a summary of each round's findings and dispositions to
   the session doc under "Phase 6 - Spec hardening."

## Session document - keep it rich

The session doc is a first-class deliverable, not a log dump. For each phase
include: the verbatim seat replies (proposals, debate, submissions, merge turns,
vote tables), a short orchestrator note on what happened and why, and the
strategies seats revealed. Someone should be able to read only this file and fully
follow how the winner emerged. Update it at the end of every phase - do not batch
it all to the end.

## Guardrails

- **Seats never talk to each other.** You relay 100% of inter-seat messages.
- **No self-votes**, and no voting for a merged app you co-own.
- **Discards are real** - a failed 10-turn merge drops the app; say so.
- **Keep seats alive across rounds** via SendMessage; re-spawning resets memory
  and breaks the negotiation.
- **Nothing merges.** This skill and the build it launches stay entirely on the
  `suite-brainstorm` branch (feature branches off it). Merging brainstorming work
  into `main`/`stable` is the human maintainer's decision alone - never do it here.
- Follow repo norms in anything you write: no `Co-Authored-By` footer, no em
  dashes are fine to keep out of committed docs per house style, commit the two
  docs at milestones.

## Phase 7 - Hand off to the autonomous build (automatic)

Once the spec has converged (Phase 6 complete, zero remaining blocker/major
findings) and both documents are committed on `suite-brainstorm`, **immediately
invoke the `app-build-from-spec` skill** (via the Skill tool) with the winner's
spec path `docs/brainstorming/<stamp>_APP_DESIGN_<appname>.md`. This chains the
session directly into building the app - scaffolding, local Docker deploy, extensive
tests, Launchpad + infra wiring, docs, gilligan screenshots, and the marketing site,
all on `suite-brainstorm` with the post-commit-review pipeline running after each
push. The build skill owns its own branch/merge gates; it never merges to `main`.

## Done means

`docs/brainstorming/<stamp>_BRAINSTORMING_SESSION.md` fully narrates the session
through the declared winner, and `docs/brainstorming/<stamp>_APP_DESIGN_<appname>.md`
holds a top-tier, reuse-maximizing spec that survived (at least) two adversarial
rounds with no remaining blocker/major findings. Record the winner, the runner-up, and
the two file paths in the session doc, then **immediately continue to Phase 7** (the
autonomous build). This loop never pauses for human review or approval between phases -
it flows brainstorm -> spec -> build without waiting for anyone.
