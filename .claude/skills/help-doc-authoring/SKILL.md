---
name: help-doc-authoring
description: >-
  Standard for authoring and reviewing BigBlueBam per-app help.md files.
  Use whenever writing, structuring, or checking a help document for any app
  in the suite. Defines the canonical template, the User Story format, source
  priority, writing conventions, and the acceptance checklist.
---

# Help Doc Authoring Standard

## Output contract

One `docs/apps/<app>/help.md` per app, containing in order:
1. Overview (what it is, who it is for, key concepts, where to find it)
2. Feature reference (explicit how-to steps for every user-facing feature)
3. User Stories (named, step-by-step walkthroughs covering common use cases)
4. Related (handoffs to other apps, links to guide.md and MCP-tools reference)

The full skeleton is reproduced at the end of this skill.

## Source priority

Code > existing docs/apps/<app> docs > marketing and screenshots > README.
Document what the code does. If a doc or marketing claim is not backed by a
route, component, or MCP tool, do not write it as fact; flag it.

## Writing conventions

- Clear, direct, second person, task-oriented. Help docs, not marketing.
- No em dashes. Use spaced hyphens ( - ) or restructure.
- Use the app's real UI labels, exactly as rendered, capitalization included.
- Counts come from the code. Phrase growing counts as "over N".
- Reference only screenshots that exist in docs/apps/<app>/, by relative path.
- Include an "AI agent" note where agents commonly drive a feature, pointing at
  the relevant MCP tools, but keep the human walkthrough primary.

## User Story format

Each story has: a `Who`, a `Goal`, a `Before you start`, numbered `Steps` that
name exact UI elements, a `Result`, and an optional `Related`. A new user must
be able to finish the story from its steps alone.

## Acceptance checklist (the doc is done when all are true)

- [ ] Every section of the template is present and filled.
- [ ] Every user-facing feature found in the frontend has how-to steps.
- [ ] Every common workflow has a User Story; setup, core loop, collaboration,
      search/reporting, and at least one agent flow are covered where supported.
- [ ] Every UI label used appears in the actual frontend code.
- [ ] Every feature claim traces to a route, component, or MCP tool.
- [ ] No em dashes. Numbers accurate. Screenshots exist.
- [ ] Reads as the same product as the other apps' help docs.

## Canonical skeleton

```markdown
# <Display Name> - <One-line description of what it is>

> <One or two sentences: the job this app does and who reaches for it.>

## Overview

<2 to 4 short paragraphs: what the app is for, the problems it solves, and how
it fits with the rest of the suite. Name the core objects the user works with.>

### Key concepts

- **<Concept>** - <plain-language definition in the app's own vocabulary>
- ... (cover every term a new user must know: the nouns the app is built around,
  the views, the states, the roles that matter)

### Where to find it

<The SPA path (for example /beacon/), how to reach it from the main nav, and any
prerequisites - permissions, an org, a project - needed before the app is usable.>

## Feature reference

<One subsection per user-facing feature. For each: what it does, where it lives
in the UI, and the explicit steps to use it. Group related features. Cover every
view, panel, action, and setting a user can touch.>

### <Feature name>

<What it is and when you would use it.>

To <do the thing>:

1. <step>
2. <step>
3. <expected result>

<Repeat for every feature.>

### Working with AI agents

<Short section: which of this app's actions agents commonly perform, the MCP
tools that drive them, and anything a human should know about reviewing or
approving agent work in this app. Point to docs/apps/<app> MCP-tools reference
for the full catalog.>

## User Stories

<The complete set of common use cases as named, step-by-step stories. See the
format in the User Story section above. Order them from most common /
onboarding-level to advanced.>

### Story: <short imperative title>

**Who:** <the role / persona doing this>
**Goal:** <the outcome they want, one sentence>
**Before you start:** <preconditions - permissions, existing objects, settings>

**Steps**

1. <Concrete action. Name the exact button / menu / field. Say where it is.>
2. <Next action, including anything the user must type or choose.>
3. <Continue until the goal is reached.>
4. <Final step.>

**Result:** <what the user sees and what state the system is now in.>

**Related:** <optional - features or other stories that extend this one, and any
MCP tool an agent would use to do the same thing.>

## Related

- Links to the other apps this one commonly hands off to or pulls from.
- Link to the app's MCP-tools reference and guide in docs/apps/<app>/.
```
