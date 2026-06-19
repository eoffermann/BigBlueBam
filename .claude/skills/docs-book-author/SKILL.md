---
name: docs-book-author
description: >-
  Assemble or extend the printable, textbook-style BigBlueBam manual (the DOCX
  and PDF offered from /docs). Use when asked to build the downloadable manual,
  add or refresh a chapter, write chapter intros/callouts/quizzes, or change the
  book's design. Produces a bold, colorful, per-app book from the SAME content
  as the web docs, then converts to PDF.
---

# docs-book-author: design and assemble the BigBlueBam textbook manual

You turn the live web docs into a book someone would happily buy on Amazon to
learn the software: bold, colorful, per-app, genuinely useful. You do NOT rewrite
the instructional content. You layer engagement on top and lay it out with a
designer's eye.

**Read first:** `docs/docs-book-style-guide.md`. It is the design system (page,
color, typography, chapter openers, the recurring graphic elements, the quiz
convention, the per-app accent palette, the production pipeline). This skill is
how you execute it. If the two ever disagree, the style guide wins; update it.

## The pipeline at a glance

```
docs/apps/<app>/help.md ──(build-manual.mjs)──▶ site/src/content/manual.generated.json
                                                          │  (same text the /docs page renders)
scripts/docs-book/enhancements/<app>.json  ◀── you author this layer
                                                          ▼
node scripts/docs-book/build-book.mjs --app=<app> --pdf
                                                          ▼
site/public/downloads/BigBlueBam-*.docx  ──(LibreOffice)──▶ .pdf
```

The generator (`scripts/docs-book/build-book.mjs`) reads the chapter content
verbatim, applies the per-app design system, injects the enhancement layer, and
writes DOCX. With `--pdf` it converts via headless LibreOffice. `--app=<app>`
builds one chapter (a sample); no flag builds the full 16-chapter book.

## Your job per chapter: author the enhancement file

Each chapter's only authored layer is `scripts/docs-book/enhancements/<app>.json`.
A chapter still renders without one (default opener, no quiz), but the file is how
it gets its personality. Schema:

```jsonc
{
  "app": "bam",
  "tagline": "Plan it, drag it, ship it.",          // one line, white on the opener
  "intro": "2 to 4 sentences...",                    // authored chapter intro (the card)
  "atAGlance": ["3 to 5 short 'best at' bullets"],
  "pullQuotes": [                                     // lift a key line, point at a feature
    { "after": "<exact phrase from the chapter>", "text": "<the pull-quote line>" }
  ],
  "callouts": [
    { "after": "<exact phrase>", "type": "tip|important|warning|note|tryit", "text": "<one tight paragraph>" }
  ],
  "quiz": [
    { "type": "mc", "q": "...", "choices": ["...","..."], "answer": "<exact matching choice>", "where": "Section name" },
    { "type": "short", "q": "...", "answer": "...", "where": "Section name" }
  ]
}
```

### Anchoring rules (this is where it goes wrong)

- `after` is a substring that must appear in the chapter's source text. The
  generator collapses whitespace before matching, so a phrase that crosses a
  line wrap still matches. Even so, pick a distinctive 6 to 12 word phrase and
  copy it from the real text. If a callout does not appear in the output, your
  anchor phrase is wrong: grep the chapter for it.
- Anchors match paragraph text AND list-item text. Many key facts (defaults,
  limits, gotchas) live in the "Key concepts" bullet list; anchor to those.
- Each anchor fires once. Use distinct phrases.

### Authoring rules (non-negotiable)

- **No em dashes anywhere.** Reword. (House rule across all BigBlueBam writing.)
- **No invented facts.** Intros, callouts, and quizzes describe only what the
  source chapter actually says. Tool counts and behavior come from the docs.
- **Quiz answers must be findable in the chapter**, and every question cites the
  section in `where`. Mix a couple multiple-choice with a couple short-answer.
  Make them about real, useful behavior, not trivia.
- **Agent language is capability, never turnkey or free.** "An agent can run a
  sprint", never "agents run your sprints" or anything implying agents ship
  deployed or free. (See `docs/marketing-voice.md`.)
- **Callouts:** one idea each. Tip = a smarter way. Important = will bite you.
  Warning = destructive/irreversible. Note = clarification. Try It = a one-line
  exercise the reader can do right now.
- **Pull-quotes** point at a marquee feature, at most one per major section.

## Build and verify

1. Author `enhancements/<app>.json`.
2. Build: `node scripts/docs-book/build-book.mjs --app=<app> --pdf` from
   `scripts/docs-book/`.
3. **Verify the output**, do not trust that it generated. Unzip the DOCX and grep
   `word/document.xml`, or read the PDF, and confirm against the definition of
   done:
   - The opener renders (full-color panel, `CHAPTER N`, app name, tagline, intro
     card).
   - Every callout you authored appears (`grep -o ">TIP<"`, `>NOTE<`, `>WARNING<`,
     `>TRY IT<`). A count of 0 means a broken anchor: fix the phrase.
   - Both pull-quotes appear; every screenshot has a `Figure N.M` caption.
   - The "Check yourself" quiz and "Answer key" are present.
   - Zero em dashes: `unzip -p <docx> word/document.xml | grep -c "—"` is 0.
4. If the PDF step fails, a stale LibreOffice instance (or a self-update) may hold
   the single-instance lock. Kill `soffice.exe`/`soffice.bin`, wait a few seconds,
   and re-run. The generator already kills-and-retries once.

## Full book

`node scripts/docs-book/build-book.mjs --pdf` builds all 16 chapters in order
(Bam first, then alphabetical) with front matter (title page) and per-chapter
sections. Output: `site/public/downloads/BigBlueBam-Manual.{docx,pdf}`, the
committed artifacts the `/docs` download buttons serve. Run it whenever a chapter
or its enhancement file changes, then commit the regenerated artifacts.

## Per-app accent palette

bam `#2563EB`, banter `#7C3AED`, beacon `#059669`, bearing `#0891B2`, bench
`#4F46E5`, bill `#16A34A`, blank `#9333EA`, blast `#DC2626`, blueprint `#0284C7`,
board `#4338CA`, bolt `#EA580C`, bond `#DB2777`, book `#0D9488`, brief `#D97706`,
bureau `#6D28D9`, helpdesk `#E11D48`. (Mirrored in the generator's `ACCENT` map
and the style guide.)

## Hard rules recap

Same content as the web docs, verbatim. No em dashes. No invented facts. Quiz
answers live in the chapter. Capability agent language. Verify the output, never
assume it rendered.
