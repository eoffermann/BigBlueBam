---
name: github-issue-cull
description: Triage, investigate, mitigate, and (after sign-off) resolve the open GitHub issues on eoffermann/BigBlueBam. Builds a dated issue_mitigations_<YYYYMMDD>.md dossier, posts an "investigating" acknowledgement on each issue, implements least-disruptive fixes on per-issue branches, has an independent agent re-verify each fix from the code alone, reports to Eddie, and on his go-ahead merges main→stable + closes addressed PRs. Use when asked to work through / cull / clear the repo's open issues. Pairs with the github-pr-cull companion skill for the unmerged-PR pass.
---

# GitHub issue cull — investigate → mitigate → verify → report → (gated) ship

You are clearing the open issues on **`eoffermann/BigBlueBam`** end to end. The
job is not to close issues fast — it is to understand each one against the real
code, fix what has a clear path with the *least disruptive* change, have a
*second, independent* pass confirm the fix from the code alone, and hand Eddie a
crisp report. Merging to production is **his** call, never yours.

Use the `gh` CLI for every GitHub interaction (issues, comments, PRs, merges).
Delegate the deep per-item analysis to the subagents below; keep the stateful,
outward-facing actions (comments, branches, merges) in the main conversation so
the human gates hold.

## Subagents this skill drives

- **issue-investigator** — one invocation per issue. Given the issue + any linked
  PR, investigates the claim against the code (does it reproduce, what's the
  source, who's affected, is it even valid) and returns a structured assessment
  + mitigation options. Read-only.
- **issue-fix-verifier** — one invocation per *implemented* fix. Given ONLY the
  original claim + the branch diff (NOT the implementer's reasoning), it
  re-derives from the code/profiling whether the issue is resolved and rates its
  confidence. This is the adversarial second opinion — keep it blind to your
  rationale on purpose.
- **pr-evaluator** — used in the PR pass (see github-pr-cull). Judges whether an
  open PR is a sound approach.

## Hard gates (read first)

1. **Never merge to `stable` (production) without Eddie's explicit sign-off.**
   `stable` auto-deploys to Railway. Phase 5 STOPS and reports; Phase 6 only runs
   after he says go. (See [[project_prod_deploy_mechanism]] /
   [[feedback_stable_promotion_monitor]].)
2. **Posting to a real issue is outward-facing.** Acknowledgement comments
   (Phase 2) are explicitly authorized, but keep them measured — "investigating,
   here's our early read" — never promise a fix or a date you haven't proven.
3. **Least-disruptive changes only.** One branch per issue, scope kept tight; no
   drive-by refactors. Follow repo norms: new numbered migrations (never edit an
   applied one), `pnpm typecheck`, no `Co-Authored-By` lines, no
   `docker compose down -v`.
4. **Prove fixes locally before claiming resolution** — apply the ui-debug
   standard (walk the stack + a live smoke on the local stack, self-cleaning test
   data). A green typecheck is necessary, never sufficient.

## Phase 0 — Scope & scaffold

1. Confirm tooling: `gh auth status`; `gh repo view eoffermann/BigBlueBam --json name`.
2. Enumerate open issues:
   `gh issue list --repo eoffermann/BigBlueBam --state open --limit 200 --json number,title,url,labels,author,createdAt,updatedAt,comments`
3. For each issue, find linked/ referencing PRs:
   `gh pr list --repo eoffermann/BigBlueBam --state open --search "<#number>" --json number,title,url,headRefName` and scan the issue body/timeline for `Fixes #`, `Closes #`, branch names, or commit links.
4. Create the dossier `issue_mitigations_<YYYYMMDD>.md` at the repo root (stamp
   the date from the environment's current date — do not hardcode). Header +
   one `## Issue #<n> — <title>` section per issue, each with subsections:
   **Issue** (URL, reporter, date) · **1. Investigation** · **2. Mitigation** ·
   **3. Acknowledgement posted** · **4. Implementation** · **5. Independent
   verification** · **6. Status/confidence**.
5. Decide order: smallest-blast-radius / clearest issues first; group issues that
   touch the same subsystem so you investigate it once.

## Phase 1 — Investigate each issue (delegate)

For each issue, spawn **issue-investigator** with: the issue number, title, body,
labels, reporter, and the linked-PR ref(s) if any. It returns:
- **Valid?** reproduces / partially / can't-repro / not-a-bug (with why).
- **Source** — the exact `file:line`(s) and mechanism; when it was introduced if findable.
- **Who's affected** — roles, orgs, conditions; how common.
- **If a PR exists** — does the diff actually address the root cause? sound,
  incomplete, or wrong, with reasons.
- **Mitigation options** — ranked, least-disruptive first, each with rough effort
  and risk, and a recommended path.

Write its findings verbatim-enough into the dossier's sections 1–2. Don't skip an
issue because it "looks invalid" — record the evidence that it's invalid.

## Phase 2 — Acknowledge on the issue

Post a brief, measured comment with `gh issue comment <n> --repo eoffermann/BigBlueBam --body "..."`:
> Thanks — this is being investigated. Early read: <2–4 sentence assessment from
> Phase 1>. We'll follow up here with the outcome.

Record the comment URL in dossier section 3. If an issue is assessed **not a
valid bug**, say so politely with the reason instead of promising a fix.

## Phase 3 — Implement (clear-path issues only)

For each issue with a clear, low-risk path:
1. Branch off `main`: `git switch -c issue-<n>-<short-slug>`. (Git refs can't
   contain spaces or `:`, so the literal `[ISSUE: <n>]` marker goes in the commit
   messages and the eventual PR title, not the branch name.)
2. Make the **minimum** change that resolves the root cause. Honor every repo
   convention (migrations, shared Zod, no co-author, etc.).
3. `pnpm typecheck` + targeted tests; then a **live smoke** on the local stack
   (rebuild + recreate the affected service, `docker compose restart frontend`
   after any `*-api`; never `-v`). Self-clean any test data.
4. Commit with `[ISSUE: <n>]` in the subject. Record the branch, the diff
   summary, and the smoke evidence in dossier section 4.

If there's no clear path, document the options + open questions in section 4 and
mark the issue **needs-decision** rather than guessing.

## Phase 4 — Independent verification (delegate, blind)

For each implemented fix, spawn **issue-fix-verifier** with ONLY: the original
issue claim and the branch diff (`git diff main...issue-<n>-<slug>`). Do NOT pass
your own reasoning. It independently judges, from the code (+ any profiling it
runs), whether the claim is resolved and returns a **confidence rating**
(High/Medium/Low + a 0–100 number + the specific evidence and any residual gaps).
Record it in section 5. If it comes back Low or finds a gap, loop back to Phase 3.

## Phase 5 — Report to Eddie (STOP here)

Produce a short, clear report (also append to the dossier section 6 per issue):
for each issue — the problem, the mitigation approach, what shipped on which
branch, and the independent verifier's confidence. List the issues with a
ready-to-merge fix, the ones needing a decision, and the ones assessed invalid.
**Stop and wait for Eddie's go.** Do not merge or close anything yet.

## Phase 6 — On sign-off: ship & close

Only after Eddie approves, per approved issue:
1. Merge the branch to `main` (PR or `--ff-only`), then promote `main`→`stable`
   (fast-forward push). **Monitor the Railway rollout** and report when prod has
   picked up the commit (per [[feedback_stable_promotion_monitor]]); fix a stuck
   deploy via Railway, never empty commits.
2. `gh issue comment <n>` with the resolution + the commit/PR link; close it
   (`gh issue close <n>`) — or let the merge auto-close it via `Closes #<n>`.
3. Delete the branch (`git branch -d` + `git push origin --delete` if pushed).
4. For any PR that addressed this issue: comment with the disposition and close it
   (`gh pr close <n> --comment "..."`) if it's superseded by the merged fix.

## Phase 7 — Unmerged-PR pass

After the issues, run the **github-pr-cull** companion skill to assess every
remaining open PR (sound? merge / revise / close), implement or document, and
summarize for Eddie under the same sign-off gate.

## Done means

Every open issue has: a dossier section, an acknowledgement comment, and either a
verified fix on a branch (awaiting or past sign-off) or a documented
reason/needs-decision. The report names each issue, its mitigation, and the
independent confidence. Nothing reached `stable` without Eddie's explicit go.
