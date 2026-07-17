---
name: post-commit-review
description: Run the automated code-review pipeline after commits are pushed to a BigBlueBam branch - launches ci-watchdog, security-analyst, stability-reviewer, and best-practices-reviewer in parallel; their findings become automated-review-labeled GitHub issues that the next coding step must address first. Use after every push during autonomous build work.
---

# Post-commit review pipeline (BigBlueBam)

Run this after every push to `github.com/eoffermann/BigBlueBam`. It fans out the four
review agents over the pushed commits, collects their findings as labeled GitHub issues,
and queues those issues as the next coding step's first task. It is the code-review half
of the autonomous brainstorming-to-build workflow (the build half is the
`app-build-from-spec` skill).

## Preconditions

- The commit(s) to review are already pushed to the remote (CI runs on GitHub, so the
  ci-watchdog needs the push). Push the **branch** only - never `main`/`stable`.
- One pipeline run covers a whole push. If several commits were pushed at once, do not
  run it per-commit.

## Procedure

1. **Launch all four agents in parallel** (single message, four Agent tool calls), each
   given the pushed commit SHA(s) and the branch name:
   - `ci-watchdog` - waits for the GitHub Actions runs the push triggered and files
     `ci`-labeled issues for failures and warnings (distinguishing flaky from real).
   - `security-analyst` - reviews the pushed diff for RLS/auth/can_access/agent_policies
     /secrets/injection issues.
   - `stability-reviewer` - reviews for idempotency/retry/race/retention/degradation issues.
   - `best-practices-reviewer` - reviews for convention drift, shared-Zod/Bolt-catalog
     /surface-map/migration issues, and drift from the driving APP_DESIGN spec.

2. **Collect results.** Each agent returns a report of issues filed (or "no findings").
   Summarize the combined outcome: total issues with numbers, titles, and labels.

3. **Queue the fixes.** Open `automated-review` issues are the first order of business for
   the next coding step:
   - Before the next build task, run `gh issue list --state open --label automated-review`.
   - Fix each in its own commit whose body contains `Fixes #<n>` so the push closes the
     issue and cross-references the commit. No `Co-Authored-By` footer.
   - If an issue is judged not worth fixing, close it with a comment explaining why
     (`gh issue close <n> --comment "..."`) - never silently ignore it.

4. **Do not recurse.** The fix commits from step 3 get reviewed by the *next* pipeline run
   after they are pushed; do not launch a new pipeline from within this one.

## Notes

- If `gh run list` shows CI still in progress, the ci-watchdog handles the waiting -
  launch it anyway.
- Trivial pushes that change no code or config (e.g. a doc typo) still get the ci-watchdog;
  the three code reviewers may be skipped at your discretion.
- **This pipeline never merges or promotes.** Findings are advisory issues on the branch.
  Merging brainstorming-build work into `main` is the human maintainer's decision alone.
