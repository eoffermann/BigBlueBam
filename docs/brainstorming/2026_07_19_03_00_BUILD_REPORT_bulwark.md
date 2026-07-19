# Bulwark build report - autonomous cycle 2026-07-19

Winner of the 2026-07-19 (03:00) suite-brainstorm session: **Bulwark**. Spec
`docs/brainstorming/2026_07_19_03_00_APP_DESIGN_bulwark.md` converged after 3 adversarial
rounds. Built end to end on `suite-brainstorm`; nothing merged or promoted to
`main`/`stable`.

Human actions required: see `docs/brainstorming/2026_07_19_03_00_HUMAN_SETUP_bulwark.md`
(2 items + the standing promotion note - one is an external-credential rotation, see below).

## What shipped

Bulwark is an AI contract-obligation monitor: it extracts a clause-cited obligation ledger
from executed contracts (Bin assets, via the internal llm-provider), binds each obligation
to a Bolt event pattern plus a manual-trigger affordance, fires timezone-anchored notice
deadlines against reality as it is logged, and drafts notices/compliance chases into the
shared `agent_proposals` HITL review queue. Nothing sends unattended. Plus vendor-compliance
chasing.

Milestones (all committed on `suite-brainstorm`):
- **M1-M3** `apps/bulwark-api` Fastify service on port 4021 (env, db, redis/auth/rls/
  permissions plugins, health, ws) + the 9-table data model (migrations `0234_bulwark_core`
  / `0235_bulwark_compliance`, RLS on `app.current_org_id`, self-FKs, the unique arm index,
  the Bulwark System service user `...00b2`) + shared Zod (`packages/shared/src/schemas/
  bulwark.ts` + the `bulwark-arm-key` subpath). Commit `88496243`.
- **M4** all `/v1` REST routes split by resource, the extraction / firing / deadline-math /
  send engines, project-membership scoping on reads AND writes, the `/v1/internal/events`
  inbox (fail-closed on empty secret), the canonical HITL send path, the proposal-decided
  subscription, project-scoped `/bulwark/ws`. Commit `5fff08e2`.
- **M5** the 16 `bulwark_*` MCP tools at full parity via `registerTool` (confirm-token on
  the 4 destructive, `asker_user_id` + `can_access` on source-scoped reads/writes,
  `bulwark.*` allowlist). Commit `4213da10` (+ `c9b6906e` discard-notice).
- **M6** 7 BullMQ workers + 6 Bolt events + the bolt-api dispatch hook + the REAL Blast
  transactional send (a new blast-api internal route) + the Braid internal resolve route
  (IN7) + migration `0236` arm-key component columns + auto-arm gating. Commits `ff65702f`,
  `75762e15`.
- **M7** the SPA (shared `/b3/` shell + Bureau widget, 6 pages: obligation ledger, deadline
  radar, notice review queue, vendor compliance matrix, contract detail, settings) + a
  branch-wide `vite build` fix (kept `node:crypto` out of the browser barrel). Folded into
  `ff65702f`; register-contract UI added in `4a382dc9`.
- **M8** Launchpad tile + `shield-check` icon, docker-compose wiring, both nginx source
  configs + regenerated Railway, frontend Dockerfile, services catalog, `visibility.service.
  ts` branches (bulwark.contract/obligation/deadline) with 11 tests, CLAUDE.md; and the
  permission catalog: 12 hand-authored `bulwark.*` rows + regenerated codegen + delta
  migration `0237` + custom-tiered built-in-group defaults `0238`. Commits `2850aa97`,
  `460f6765`, `c889f3a7`, `5aab97dd`.
- **M9** help.md + help-index.json + guide.md + verified Help Center wiring. Commit
  `5b787022`.
- **M10** gilligan screenshots (light + dark) into `docs/apps/bulwark/screenshots/` and
  `site/public/screenshots/bulwark/`. Commit `36b4bde3`.
- **M11** marketing section on the Operations page + suite counts bumped to 849 tools / 22
  apps. Commit `e4b150fc`.

## Tests + CI status

- **Static gates green locally:** typecheck (shared, bulwark-api, bulwark, worker, bolt-api,
  braid-api, blast-api, mcp-server, api, ui), `check-bolt-catalog` (0), `lint:migrations`
  (0, 200 files), surface-map self-check (0), `check-permission-catalog` (in sync, 1423
  rows), the 11 visibility branch tests. `db:check` shows no bulwark drift.
- **CI:** the push triggered the branch workflows (suite-brainstorm was already wired into
  the push filters during the Braid cycle). The initial Test-shard red (bulwark-api /
  braid-api declared `vitest run` with no colocated tests) was fixed with `--passWithNoTests`
  (#68).
- **Phase 4 backend + UI verification PASSED (live, gilligan):** registered a "Castaway
  Rescue Subcontract" via the real `POST /v1/contracts` (Bin `can_access` preflight passed);
  confirmed + armed a `bam:task.overdue` notice obligation; `state-reconcile` armed the
  deadlines timezone-anchored to Pacific/Honolulu and a second run added zero (no double-arm,
  validating #67); drafted a notice into `agent_proposals` (refs-only, null approver);
  approve-send returned `send_failed` on an unresolvable recipient (never a false `sent`,
  validating #64) then `sent` only after transport confirmed with a real recipient; the
  Redis dispatch gate carried the binding immediately after confirm (validating #65); a
  compliance chase drafted a proposal; a non-project member and an `asker_user_id`-narrowed
  admin both saw nothing (project-scope + asker fail-closed); the MCP tools returned the
  seeded data for a gilligan admin and a non-allowlisted service account got
  `TOOL_NOT_ALLOWED`.
- **Phase 4 e2e: 6/6 passing** (`apps/e2e/src/apps/bulwark/tests/bulwark.spec.ts` -
  ledger, radar, notice queue, compliance, settings, project-scope negative).

## automated-review issues filed + disposition

The post-commit-review pipeline filed 8 issues over the M4-M8 push; ALL fixed + closed:
- **#63** (security): notice_draft body floor bypassed in the asker path. Fixed `9709b341`.
- **#64** (stability, high): notice/chase marked `sent` before transport confirmed. Fixed
  `45104650`.
- **#65** (stability, high): the Redis dispatch gate was never updated on confirm. Fixed
  `e0431e7b`.
- **#66** (best-practices): CLAUDE.md tool-count drift. Fixed `038d0c32`.
- **#67** (stability): arm-key epoch divergence (latent double-arm). Fixed `7b4942a7`.
- **#68** (ci): Test workflow red (vitest empty package). Fixed `9709b341`.
- **#69** (stability): unbatched high-churn retention DELETE. Fixed `8a8ddeab`.
- **#70** (best-practices, high): `tmp/` scratch + an App Store Connect probe dump swept
  into a pushed commit. Removed from HEAD + gitignored `038d0c32`; issue body redacted.

**Disclosure note (public repo):** three reviewer agents published exploit-grade / PII
detail into public issues (#63, #64, #70). The sensitive issue bodies were redacted, the
underlying bugs fixed fast, and the exposure is recorded in the HUMAN_SETUP doc. This is a
recurring reviewer-agent behavior (also seen on Braid #60/#62) worth a durable fix.

## main -> branch sync

`suite-brainstorm` was current with `main` (migration tip 0233 at cycle start); the sync was
a clean no-op. Nothing was merged branch -> main.

## Human actions required

See `docs/brainstorming/2026_07_19_03_00_HUMAN_SETUP_bulwark.md` (2 items):
1. **Rotate the exposed App Store Connect API key** and decide on a history rewrite - a
   pre-existing untracked `tmp/asc-probe/` dump (a decoded ASC JWT + tester PII, from a prior
   FRNDO session, NOT Bulwark code) was swept into pushed public history by a broad
   `git add`; removed from HEAD + gitignored, but still in history at `ff65702f`.
2. The standing note that promotion to `main`/`stable` is the maintainer's decision.

No third-party account, OAuth registration, paid provider, or DNS is needed to RUN Bulwark -
all its dependencies are internal.

## How to see it in action

1. Stack is live locally. Open the Launchpad on any app and click the **Bulwark** tile
   (Contract Obligations, shield-check icon) -> `/bulwark/`. Log in at `/b3/login` as
   `skipper@gilligantravel.example` / `Castaway2026!`.
2. **Obligation Ledger** (`/bulwark/`): the "Castaway Rescue Subcontract" with 3 clause-cited
   obligations; the notice is **Confirmed + armed**. The **Register contract** button (top of
   the Contracts rail) onboards a new contract from a Bin asset.
3. **Deadline Radar** (`/bulwark/radar`): armed clocks with Pacific/Honolulu countdowns.
4. **Notice Queue** (`/bulwark/notices`): a drafted notice with **Approve and send** /
   **Discard draft** / **Waive deadline**. Nothing sends unattended.
5. **Compliance** (`/bulwark/compliance`): the Howell T1 vendor row, **COI** column, expiring.
6. Confirm the seeded contract:
   `docker compose exec -T postgres psql -U bigbluebam -d bigbluebam -c "SELECT title, status, extraction_status FROM bulwark_contracts WHERE organization_id='57db0001-3f0e-463f-b514-1cd14fd14241';"`
   -> `Castaway Rescue Subcontract | active | extracted`.
7. Agents: the 16 `bulwark_*` MCP tools are registered and fail closed until an operator
   allowlists `bulwark.*` per agent (`agent_policies`).
8. Re-run the e2e: from `apps/e2e`,
   `E2E_ADMIN_EMAIL=skipper@gilligantravel.example E2E_ADMIN_PASSWORD='Castaway2026!' E2E_MEMBER_EMAIL=professor@gilligantravel.example E2E_MEMBER_PASSWORD='Castaway2026!' E2E_BASE_URL=http://localhost npx playwright test --project=setup --project=bulwark --workers=1`
   -> 6/6.

Merging `suite-brainstorm` into `main`/`stable` is the maintainer's decision; nothing was
merged or promoted.
