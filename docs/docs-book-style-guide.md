# BigBlueBam Manual: Textbook Style Guide

This is the design system for the printable, downloadable BigBlueBam manual: the
DOCX and PDF offered from the `/docs` page. The goal is a book that looks like
something you would happily buy on Amazon to learn a new piece of software, not a
PDF dump of a help site. Bold, colorful, confident, and genuinely useful.

It is also the reference for the `docs-book-author` skill, which assembles the
book. Read this before changing the generator or authoring chapter content.

> **North star:** a reader should be able to flip to any page, get pulled in by a
> colored callout or a pull-quote, and learn one concrete thing without reading
> the whole chapter.

## 1. What we keep, what we add

**Same content as the web docs.** The body text is the exact prose from each
app's `docs/apps/<app>/help.md` (aggregated into `site/src/content/manual.generated.json`).
We do not rewrite the instructional content. The book and the website teach the
same thing in the same words, so they never drift.

**What the book adds on top, for engagement:**

- A bold per-chapter **opener page** (full color, app accent).
- A short **chapter intro** (2 to 4 sentences) that frames why the app matters
  and what the reader will be able to do by the end. Authored, warm, concrete.
- **Pull-quotes** that lift a key feature line out of the body and point at it.
- **Callout boxes** (Tip, Important, Note, Try It) drawn from the material.
- **Figure captions** under each screenshot.
- An end-of-chapter **review quiz** whose answers are all in the chapter, plus an
  answer key.
- Front matter (title page, "how to use this book", table of contents) and back
  matter (combined answer key, index of apps).

Everything added is clearly additive. We never invent product behavior. If the
help text does not say a feature ships, the book does not imply it does. Agent
language follows the marketing rule: capability ("an agent can"), never a turnkey
or "free to run" promise.

## 2. The hard rules

- **No em dashes anywhere.** Reword. Use a period, comma, colon, or parentheses.
  (House rule across all BigBlueBam writing.)
- **No invented facts, screenshots, or numbers.** Tool counts and feature claims
  come from the source docs and `meta.json`.
- **Every chapter earns its color but stays readable.** Color lives in openers,
  callout fills, rules, and headings. Body text is near-black on white. We never
  set long body copy in white-on-color or in the accent color.
- **One idea per callout.** A callout is a single, scannable thought.

## 3. Page and layout

- **Trim:** US Letter (8.5 x 11 in) for easy home printing. Margins 1 in top and
  bottom, 1 in outer, 1.1 in inner (room for binding).
- **Single column** body for readability at this trim.
- **Running header:** chapter name on the left, "BigBlueBam Manual" on the right,
  thin accent rule beneath, in the chapter's accent color.
- **Running footer:** page number, outer-aligned.
- **Chapter openers** start on a new page and are full-bleed color (see 6).

## 4. Color system

Neutrals: body text `#18181B` (near-black), secondary text `#52525B`, hairlines
`#E4E4E7`, code background `#F4F4F5`. White page.

Each chapter has one **accent color**, used for the opener, headings, the header
rule, pull-quote bar, and callout fills (tinted). The per-app palette:

| App | Accent | App | Accent |
|-----|--------|-----|--------|
| bam | `#2563EB` | board | `#4338CA` |
| banter | `#7C3AED` | bolt | `#EA580C` |
| beacon | `#059669` | bond | `#DB2777` |
| bearing | `#0891B2` | book | `#0D9488` |
| bench | `#4F46E5` | brief | `#D97706` |
| bill | `#16A34A` | bureau | `#6D28D9` |
| blank | `#9333EA` | helpdesk | `#E11D48` |
| blast | `#DC2626` | blueprint | `#0284C7` |

Callout fills use a 10 to 14 percent tint of the relevant semantic color (not
always the chapter accent): Tip uses the chapter accent, Important uses amber
`#D97706`, Warning uses red `#DC2626`, Note uses slate `#475569`, Try It uses
emerald `#059669`. The left border of a callout is the full-strength color.

## 5. Typography

- **Display / chapter titles:** a strong geometric sans, heavy weight, large.
  (Generator target: a bundled or system sans such as Arial Black / Montserrat
  for the opener; fall back gracefully.)
- **Headings (H2 to H4):** the same sans, semibold, in the chapter accent color,
  stepping down in size. H2 gets a short accent rule above it.
- **Body:** a readable serif (Georgia class) at 11 pt, 1.3 line spacing. Serif
  body is the "real book" signal that separates this from a web dump.
- **Code / monospace:** Consolas class, 9.5 pt, on the `#F4F4F5` block with a thin
  left accent rule.
- **Captions:** sans, 9 pt, secondary color, italic, prefixed `Figure N.M`.
- **Pull-quotes:** sans, 16 to 18 pt, accent color, with a thick accent left bar.

## 6. Chapter opener (the showpiece)

A full-page color block in the chapter accent, with:

- The chapter number, large, top, in a translucent white.
- The app name, very large, white, heavy.
- A one-line tagline (white, lighter weight).
- The 2 to 4 sentence authored intro, in a white card sitting on the color (dark
  text on white card) so it stays readable.
- A thin "In this chapter" list of the chapter's top sections.

This is the page that makes someone flipping through the book stop.

## 7. Recurring graphic elements (the eye-pullers)

These repeat throughout so the reader learns the visual language fast.

- **Pull-quote.** A short line from the body, enlarged, accent color, thick left
  bar, set off with space. Use it to point at a key feature. One per major
  section at most.
- **Callout boxes.** A rounded, tinted box with a full-color left border, an icon
  and label in the top-left, and one tight paragraph:
  - **Tip** (lightbulb, accent): a faster or smarter way to do the thing.
  - **Important** (alert, amber): something that will bite you if missed.
  - **Warning** (octagon, red): destructive or irreversible behavior.
  - **Note** (info, slate): a clarification or aside.
  - **Try It** (play, emerald): a concrete one-line exercise the reader can do
    right now in the product.
- **Key term.** First use of a product term is bold and accent-colored, with a
  one-line plain definition nearby.
- **Figure.** Every screenshot is centered, sized to the column, framed with a
  hairline, and given a `Figure N.M` caption with one wry-but-clear line.
- **At a glance.** Optional boxed list at the top of a chapter: the 3 to 5 things
  this app is best at.

## 8. End-of-chapter review quiz

Close every chapter with **"Check yourself"**: 4 to 6 questions whose answers are
all findable in that chapter. Mix formats: a couple multiple-choice, a couple
short-answer. Keep them about real, useful behavior (not trivia). Style the quiz
as a tinted box set off from the body.

Answers live in two places: a small **answer key** at the very end of the chapter
(upside-down or clearly separated so the reader can self-check), and collected in
a **combined answer key** in the back matter. Each answer cites the section where
the reader can confirm it ("see: Sprints").

## 9. Front and back matter

- **Title page:** "BigBlueBam" wordmark, "The Complete Manual", a subtitle, the
  version or date, the open-source line.
- **How to use this book:** one page explaining the callout legend (show each
  callout once) and the quiz convention.
- **Table of contents:** chapters with accent dots, plus per-chapter section lists.
- **Back matter:** combined answer key, and a short "where to go next" pointing to
  `/docs`, the deploy guide, and the repo.

## 10. Voice for the added text

Intros and quiz questions follow the marketing voice (`docs/marketing-voice.md`):
warm, clear first and clever second, confident, never boastful, and no em dashes.
But the register is instructional: we are teaching, so the added text is helpful
and direct, with at most one light smile per chapter opener. The body prose stays
exactly as the source docs wrote it.

## 11. Production pipeline

Toolchain (chosen for what runs on the build host):

- **DOCX:** generated programmatically with the `docx` npm library for full
  control over the color blocks, callout tables, and pull-quotes. Markdown is
  tokenized with `marked` and mapped to styled DOCX elements.
- **PDF:** the DOCX is converted with headless LibreOffice
  (`soffice --headless --convert-to pdf`), which is installed on the build host.
  Pandoc is intentionally not required.
- **Generator:** `scripts/docs-book/build-book.mjs`. Inputs: the chapter content
  from `manual.generated.json`, per-app accent colors (this guide, section 4),
  image dimensions from `manual-image-dims.generated.json`, and per-chapter
  enhancement files at `scripts/docs-book/enhancements/<app>.json`
  (intro, tagline, pull-quotes, callouts, quiz, answer key).
- **Output:** `site/public/downloads/BigBlueBam-Manual.{docx,pdf}` (committed
  artifacts, so the site serves them without the doc toolchain in the image), and
  per-chapter samples under the same folder when building a single chapter.
- **Run:** `node scripts/docs-book/build-book.mjs [--app=bam] [--pdf]`.

The enhancement files are the only authored layer. Generating a chapter without
its enhancement file still produces a valid chapter (opener with a default
tagline, no quiz); the file is how a chapter gets its intro, curated callouts, and
quiz.

## 12. Definition of done for a chapter

A chapter is book-ready when: it opens on a full-color page with an authored
intro; every screenshot has a figure caption; at least two callouts and one
pull-quote appear, drawn from the real material; the prose matches the web docs
word for word; a "Check yourself" quiz with an answer key closes it; and there is
not a single em dash anywhere.
