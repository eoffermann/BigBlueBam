---
name: github-pr-cull
description: Triage the open/unmerged pull requests on eoffermann/BigBlueBam — assess each PR's approach against the code, then merge / revise / close with a documented rationale, under the same Eddie-sign-off gate as the issue cull. Invoked as the Phase 7 follow-up of github-issue-cull, or standalone when asked to clear out stale PRs. Records into the same dated dossier.
---

# GitHub PR cull — assess → decide → (gated) merge or close

You are clearing the open pull requests on **`eoffermann/BigBlueBam`**. For each
PR, decide one of: **merge** (sound + current), **revise** (right idea, needs
work — do the work on the PR's branch or a follow-up), or **close** (superseded,
wrong approach, or obsolete) — every decision documented with its reason. Same
hard gates as github-issue-cull: nothing reaches `stable` without Eddie's go,
changes stay least-disruptive, and fixes are proven on the local stack before
they're called done.

## Phase 0 — Enumerate

`gh pr list --repo eoffermann/BigBlueBam --state open --limit 200 --json number,title,url,headRefName,baseRefName,author,createdAt,updatedAt,isDraft,mergeable,labels`.
For each, pull the diff + linked issue: `gh pr view <n> --json ...` and
`gh pr diff <n>`. Append a `## PR #<n> — <title>` section to the current
`issue_mitigations_<YYYYMMDD>.md` (create it if running standalone).

## Phase 1 — Evaluate each PR (delegate)

Spawn **pr-evaluator** per PR with the diff, the PR description, and any linked
issue. It returns: what the PR claims to do, whether the diff actually does that
and addresses the real root cause, correctness/risk concerns (`file:line`),
whether it still applies to current `main` (drift/conflicts), test coverage, and
a recommendation — **merge / revise / close** — with reasons. Record it.

## Phase 2 — Act on the recommendation

- **Merge candidate:** rebase/retarget onto `main` if needed, run typecheck +
  the relevant live smoke locally, then queue it for the Phase-3 sign-off (do NOT
  merge yet).
- **Revise:** push the minimal fixes to the PR's branch (or a follow-up branch),
  re-run the smoke, comment on the PR explaining what changed, then queue it.
- **Close:** comment with the rationale (superseded by <commit/issue>, obsolete,
  or approach rejected because …) and queue the close for sign-off. Don't close a
  contributor's PR silently.

## Phase 3 — Report & ship (gated)

Summarize for Eddie: per PR — claim, verdict, action, confidence. **Stop for his
go.** On sign-off: merge approved PRs to `main`, promote `main`→`stable` (FF) and
monitor the Railway rollout (per [[feedback_stable_promotion_monitor]]), close
the close-list PRs with their comments, and delete merged branches.

## Done means

Every open PR has a dossier entry, a posted disposition, and is either merged
(past sign-off), revised-and-queued, or closed with a reason. Nothing reached
`stable` without Eddie's explicit go.
