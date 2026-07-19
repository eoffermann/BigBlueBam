# Bulwark - human actions required

The Bulwark build (autonomous cycle 2026-07-19) ran headless. Everything that could be
built, wired, and tested unattended was. This document holds ONLY the items that need a
human keystroke - an external credential, a harness-blocked destructive action, or a
standing decision. Internal engineering (routes, migrations, workers, drift, local-DB
cleanup) was done in-loop and is NOT listed here.

## 1. Rotate the exposed App Store Connect credential (EXTERNAL SECRET - do this first)

**What happened:** during the build, a broad `git add` in commit `ff65702f` swept a
pre-existing, untracked `tmp/` scratch directory into the repo. That directory was NOT
Bulwark work - it was leftover output from a prior session (a "FRNDO" App Store Connect
probe) sitting in the working tree at session start. It included `tmp/asc-probe/` with a
decoded App Store Connect JWT, a TestFlight screenshot image, crash logs, and tester
detail (PII). The commit was pushed to the PUBLIC repo before the sweep was noticed.

**Already done in-loop:** the files were removed from `HEAD` and `tmp/` +
`B3-FRNDO_LAUNCH_NOTES.md` were added to `.gitignore` (commit `038d0c32`, closes #70), so
it cannot recur. The public GitHub issue that restated the JWT/PII (#70) was redacted to a
terse stub. BUT the captured files still exist in the pushed git HISTORY at `ff65702f`.

- [ ] **Rotate the App Store Connect API key** that minted the JWT in
      `tmp/asc-probe/01-jwt-decoded.json` (App Store Connect -> Users and Access -> Integrations
      -> App Store Connect API -> revoke the key id shown there, generate a new `.p8`). ASC
      JWTs are short-lived (<=20 min) so the token itself is almost certainly expired, but
      rotate the underlying key on principle since its issuer id + key id were exposed.
- [ ] **Decide whether to purge the files from history.** They are in the pushed
      `suite-brainstorm` history. To scrub them, rewrite the branch and force-push:
      ```sh
      # from a clean clone, on suite-brainstorm:
      git filter-repo --path tmp/ --path B3-FRNDO_LAUNCH_NOTES.md --invert-paths
      git push --force-with-lease origin suite-brainstorm
      ```
      This rewrites shared branch history, so anyone with a clone must re-fetch. It was NOT
      done autonomously because force-pushing rewritten public history is a destructive,
      outward-facing action that is the maintainer's call. `suite-brainstorm` is never
      promoted, so the exposure does not reach `main`/`stable`, but the history is public
      until this is run. (Note: GitHub caches force-pushed commits for a while; contact
      GitHub support if you need the dangling commit purged from their cache too.)

## 2. Promotion to trunk (STANDING DECISION - not a blocker)

- [ ] Bulwark is built, reviewed, and tested entirely on `suite-brainstorm`. Nothing was
      merged or promoted to `main`/`stable` - that is the maintainer's decision alone and
      is out of scope for the autonomous loop. Promote when you judge it production-ready
      (typically `main` -> `stable` via the documented `--ff-only` path).

## Nothing else

No third-party API key, OAuth app registration, paid provider account, or DNS is required
to RUN Bulwark - all its dependencies are internal (Postgres, Redis, Bin/Bond/Bill via the
shared DB, the internal llm-provider, Braid, Blast transactional send). The engine, HITL
send, workers, permission catalog, and infra were all built and wired in-loop.
