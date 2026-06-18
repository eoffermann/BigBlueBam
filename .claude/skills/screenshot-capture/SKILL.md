---
name: screenshot-capture
description: Produce realistic, fully-populated screenshots of any view in the BigBlueBam suite from declarative YAML recipes — auth, content seeding, deterministic capture, and a manifest. Use when creating/updating docs or marketing-site assets, or refreshing captures after a UI change.
---

# Populated Screenshot Capture

Turn a declarative "shot recipe" into a finished, populated screenshot with no
manual setup. Recipes are reproducible (frozen clock + disabled animation +
masks → near-identical re-runs), use realistic seeded data (never lorem ipsum),
and run against whatever environment is present (local docker by default).

The engine lives in **`packages/docs-capture`** (evolved from the older scene
runner). The CLI is `bbam-shots`.

## Quick start

```sh
# Local stack must be up (docker compose up -d). Then, from the repo root:
pnpm --filter @bigbluebam/docs-capture exec tsx src/cli.ts --list            # list recipes
pnpm --filter @bigbluebam/docs-capture exec tsx src/cli.ts --apps board      # capture one app
pnpm --filter @bigbluebam/docs-capture exec tsx src/cli.ts --ids board-all-boards
pnpm --filter @bigbluebam/docs-capture exec tsx src/cli.ts                    # everything
# After build: `bbam-shots --apps board`
```

Output: `screenshots/<app>/<recipe-id>.png` + `screenshots/manifest.json` at the
repo root — the **shared asset tree** consumed by both the docs and the
marketing site.

## Pipeline (per recipe)

1. **Resolve environment** (`environment.ts`) — local docker (default) →
   production (DEFERRED, gated) → raw-local fallback. Probes `/b3/api/public/config`.
2. **Authenticate** as the recipe `identity`. Fast path reuses the E2E suite's
   `apps/e2e/.auth/<identity>.json` storageState; falls back to a UI login with
   the seeded test-user creds. storageState is cached per identity per run.
3. **Evaluate + seed content** (`seeding.ts`) — if the recipe declares `content`,
   a fixture builder for that `kind` checks whether the view is already populated
   and, if not (or `force_seed`), seeds idempotently.
4. **Navigate + interact** — go to `route`, set theme, then run the ordered
   `interactions` steps.
5. **Determinism** (`determinism.ts`) — frozen clock (context `clock` API,
   `SHOTS_FROZEN_TIME`), `reducedMotion` + a no-animation stylesheet, hide the
   floating Bureau presence widget, and apply `masks`.
6. **Capture** — full page / element selector / clip rect, with `mask` boxes.
7. **Manifest** (`manifest.ts`) — append id, app, env, theme, viewport, dims,
   sha256, frozen time, and the git SHA.

## Writing a recipe

YAML under `packages/docs-capture/recipes/<app>/*.yaml` (one mapping or a list).
The directory name must equal each recipe's `app`. Schema (`recipe.ts`, Zod-validated):

```yaml
- id: board-canvas-populated          # kebab-case; output filename + manifest key
  app: board                          # selects base URL + output dir
  demonstrates: "An infinite canvas mid-brainstorm"   # drives content evaluation
  route: /board/                      # relative to the app base
  identity: admin                     # seeded identity to act as
  content:                            # OPTIONAL — omit if the view is already populated
    kind: board                       # matches a fixture builder
    spec: { lists: 3, cards: 8 }
    force_seed: false
  interactions:                       # ordered; prefer role/data-testid selectors
    - { action: waitFor, selector: "[data-testid='board-canvas']" }
    - { action: click, selector: "div.group.cursor-pointer", optional: true }
  capture:
    target: fullPage                  # fullPage | "<selector>" | "x,y,w,h" clip
    viewport: desktop-1440            # desktop-1440 | desktop-1280 | tablet-768 | mobile-390
    theme: light                      # light | dark
    deviceScaleFactor: 1              # 1 docs, 2 retina/marketing
  masks:                              # selectors painted over before capture
    - "[data-testid='relative-timestamp']"
```

Interaction `action`s: `navigate`, `click`, `hover`, `fill`, `press`, `select`,
`scrollTo`, `waitFor`, `waitForNetworkIdle`, `wait`. Add `optional: true` so a
best-effort setup step can't fail the run. A step may carry
`skipIfEnvUnset: SOME_ENV_VAR` to no-op when a secret isn't configured, and
`fill`/`navigate` values support `${ENV_VAR}` interpolation — so credentialed
legs (e.g. a separate-portal login) never hardcode secrets and simply skip when
unset.

## Verification before capture (mandatory)

The skill must never snap a view it didn't actually reach (e.g. a login error
mislabeled as a ticket list). Before every screenshot the runner:

1. Runs a built-in **error-state guard** (always on) that fails the recipe on
   common failure pages — invalid credentials, "page not found", error
   boundaries, "access denied", etc.
2. Enforces the recipe's **`expect`** (selectors/`text=` that MUST be visible)
   and **`expectNot`** (must be absent — e.g. `input#password` on a view that
   should be authenticated).

On any verification failure the recipe FAILS loudly and **no image is written**
(a stale asset from a prior run is deleted). Declare `expect` on every recipe
that depends on auth, interactions, or seeded data:

```yaml
  expect: ["button:has-text('New Board')"]   # proves we reached the Boards view
  expectNot: ["input#password"]              # proves we're past the sign-in screen
```

Helpdesk authed recipes use this: their portal login is `skipIfEnvUnset`-gated
on `SHOTS_HELPDESK_EMAIL`, and they `expectNot: input#password` — so without
`SHOTS_HELPDESK_EMAIL`/`SHOTS_HELPDESK_PASSWORD` they fail verification (no
misleading capture) instead of shooting the sign-in screen.

## Seeding (three-tier precedence)

The local stack is already broadly seeded, so **most recipes need no `content`
block** — they capture existing realistic data. When a recipe needs a precise
state, register a `FixtureBuilder` (`registerFixture`) and reference it by
`content.kind`. Inside a builder, prefer:

1. **Suite REST API / MCP** via the authenticated request context (`apiPost`/
   `apiGet`) — creates data the way a real user would.
2. **App UI flows** via the Playwright `page`.
3. **Direct Postgres** (`sqlSeed`, local-only) — last resort.

Seed idempotently (upsert by stable id) and namespace everything under the run's
`workspaceSlug` (`SHOTS_WORKSPACE`, default `screenshots-demo`).

## Environment / config

- `SHOTS_ENV` = `local` (default) | `raw` | `production` (gated: needs
  `SHOTS_ALLOW_PROD=1` — deferred in v1).
- `SHOTS_BASE_URL`, `SHOTS_FROZEN_TIME`, `SHOTS_WORKSPACE`, `SHOTS_HIDE_SELECTORS`.
- Credentials: env (`E2E_ADMIN_EMAIL`/`E2E_ADMIN_PASSWORD`, …) or a gitignored
  `screenshots.config.json` at the repo root. Never hardcode credentials.

## Known gaps (surfaced per the spec)

- **`data-testid` coverage.** Many views lack stable test ids, so some recipes
  fall back to CSS like `div.group.cursor-pointer`. Adding `data-testid` to the
  card grids, panels, and the Bureau widget (`data-testid="bureau-presence-widget"`)
  makes recipes robust. The Bureau widget is hidden via its
  `[data-bureau-docked-box]` host until a testid lands.
- **Fixture builders** are registered per `content.kind` as needs arise; the
  starter recipes lean on the existing seed where possible.
- **Asset committing** (commit PNGs vs regenerate in CI) is left to the docs /
  marketing pipelines; `screenshots/` is gitignored by default.
